import { resolvedDefaultAgent } from "@/lib/agent-settings";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@/lib/native/events";
import { exit } from "@/lib/native/process";
import { getCurrentWindow } from "@/lib/native/window";
import { toast } from "sonner";
import { AppShell } from "@/components/layout";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TerminalContainer } from "@/components/terminal";
import { KanbanBoard } from "@/components/kanban";
import { ProjectLauncher } from "@/components/projects";
import { TerminalProvider } from "@/contexts";
import { useUIStore, useEnvironmentStore, useConfigStore, useClaudeOptionsStore } from "@/stores";
import { useProjectStore } from "@/stores/projectStore";
import { startPaneLayoutPersistence } from "@/lib/pane-layout-persistence";
import { startResourceSync } from "@/lib/resource-sync";
import { startStoreResourceSync } from "@/lib/store-resource-sync";
import { hydrateLoopedReviewWorkflowsForEnvironment } from "@/lib/looped-review-persistence";
import { hydrateMultiReviewWorkflowsForEnvironment } from "@/lib/multi-review-persistence";
import {
  hydrateBuildPipelinesForProject,
  migrateLegacyBuildPipelines,
} from "@/lib/build-pipeline-persistence";
import { hydratePromptQueuesForEnvironment } from "@/lib/prompt-queue-persistence";
import { createPromptQueueSources } from "@/lib/prompt-queue-sources";
import { Toaster } from "@/components/ui/sonner";
import { ErrorDetailsDialog } from "@/components/errors";
import {
  checkDocker,
  checkClaudeCli,
  checkClaudeConfig,
  checkCodexCli,
  checkOpencodeCli,
  checkGithubCli,
  getAvailableAiCli,
  getConfig,
  getEnvironment,
  getResourceRevisionManifest,
  syncAllEnvironmentsWithDocker,
} from "@/lib/backend";
import { usePrMonitorService } from "@/hooks/usePrMonitorService";
import { useGlobalActivityMonitor } from "@/hooks/useGlobalActivityMonitor";
import { useUnreadEnvironmentSync } from "@/hooks/useUnreadEnvironmentSync";
import { useEnvironments, useEnvironmentLifecycleService } from "@/hooks";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import type { Environment } from "@/types";
import { DockerAvailabilityProvider } from "@/contexts/DockerAvailabilityContext";
import { rendererDebugLog } from "@/lib/debug-log";

export const DOCKER_AVAILABILITY_POLL_INTERVAL_MS = 60_000;

/**
 * How many consecutive failed probes it takes to declare an outage once Docker
 * has been seen healthy. One is not enough: a false negative disables every
 * container control and is not corrected until the next poll.
 */
export const DOCKER_UNAVAILABLE_CONFIRMATIONS = 2;

/**
 * A single daemon probe, normalised to a boolean. A thrown error and a `false`
 * answer mean the same thing to every caller, and neither may reject - the
 * poll would otherwise leave an unhandled rejection behind.
 */
async function probeDocker(source: "startup" | "retry" | "poll"): Promise<boolean> {
  try {
    return await checkDocker();
  } catch (error) {
    console.error(`[App] Docker ${source} check failed:`, error);
    return false;
  }
}

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

function App() {
  const selectedEnvironmentId = useUIStore((state) => state.selectedEnvironmentId);
  const selectedProjectId = useUIStore((state) => state.selectedProjectId);
  const zoomLevel = useUIStore((state) => state.zoomLevel);
  const zoomIn = useUIStore((state) => state.zoomIn);
  const zoomOut = useUIStore((state) => state.zoomOut);
  const resetZoom = useUIStore((state) => state.resetZoom);
  const environments = useEnvironmentStore((state) => state.environments);
  const getEnvironmentById = useEnvironmentStore((state) => state.getEnvironmentById);
  const setConfig = useConfigStore((state) => state.setConfig);
  const config = useConfigStore((state) => state.config);
  const setClaudeOptions = useClaudeOptionsStore((state) => state.setOptions);
  const clearClaudeOptions = useClaudeOptionsStore((state) => state.clearOptions);
  const { startEnvironment, createEnvironment, updateEnvironment } = useEnvironments(null, {
    listenForRenameEvents: false,
  });
  const [dockerAvailable, setDockerAvailable] = useState<boolean | null>(null);
  const [isCheckingDocker, setIsCheckingDocker] = useState(false);
  const [dockerWarningDismissed, setDockerWarningDismissed] = useState(false);
  const dockerAvailableRef = useRef<boolean | null>(null);
  const dockerCheckInFlightRef = useRef<Promise<boolean> | null>(null);

  // Initialize centralized PR monitoring service
  usePrMonitorService();
  // Monitor agent activity for ALL environments (regardless of selected project)
  useGlobalActivityMonitor();
  // Single registration for setup lifecycle events and resume/reconnect
  // reconciliation (previously duplicated per useEnvironments call site).
  useEnvironmentLifecycleService();
  // Opening an environment clears its unread badge for every client.
  useUnreadEnvironmentSync();
  // The backend change feed must be attached before the store bindings that
  // consume it, and both before anything that reads a backend snapshot.
  useEffect(() => startResourceSync({ loadManifest: getResourceRevisionManifest }), []);
  useEffect(() => startStoreResourceSync(), []);
  useEffect(() => startPaneLayoutPersistence(), []);
  useEffect(() => {
    void migrateLegacyBuildPipelines().catch((error) => {
      // Keep the legacy key intact so the next launch can retry after a
      // transient backend failure.
      console.warn("[App] Failed to migrate legacy build pipelines:", error);
    });
  }, []);
  // Renderer stores are projections of backend-owned queues.
  const promptQueueSources = useMemo(() => createPromptQueueSources(), []);
  useEffect(() => {
    for (const environment of environments) {
      void hydratePromptQueuesForEnvironment(environment.id, promptQueueSources).catch((error) => {
        console.warn(`[App] Failed to restore prompt queues for ${environment.id}:`, error);
      });
    }
  }, [environments, promptQueueSources]);

  // The single renderer-side hydration pass for backend-owned reviews. Resource
  // change events perform incremental refreshes; this closes the gap after a
  // renderer exit/remount, when the store starts empty.
  useEffect(() => {
    for (const environment of environments) {
      void hydrateLoopedReviewWorkflowsForEnvironment(environment.id).catch((error) => {
        console.warn(`[App] Failed to restore looped reviews for ${environment.id}:`, error);
      });
      void hydrateMultiReviewWorkflowsForEnvironment(environment.id).catch((error) => {
        console.warn(`[App] Failed to restore multi reviews for ${environment.id}:`, error);
      });
    }
  }, [environments]);

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
      void hydrateBuildPipelinesForProject(projectId).catch((error) => {
        console.warn(`[App] Failed to restore build pipelines for ${projectId}:`, error);
      });
    }
  }, [pipelineProjectIds]);
  const [claudeCliAvailable, setClaudeCliAvailable] = useState<boolean | null>(null);
  const [claudeConfigAvailable, setClaudeConfigAvailable] = useState<boolean | null>(null);
  const [opencodeCliAvailable, setOpencodeCliAvailable] = useState<boolean | null>(null);
  const [codexCliAvailable, setCodexCliAvailable] = useState<boolean | null>(null);
  const [githubCliAvailable, setGithubCliAvailable] = useState<boolean | null>(null);
  const [availableAiCli, setAvailableAiCli] = useState<string | null>(null);
  const [isCheckingClaude, setIsCheckingClaude] = useState(false);
  const [githubCliWarningDismissed, setGithubCliWarningDismissed] = useState(false);

  const selectedEnvironment = selectedEnvironmentId
    ? (environments.find((env) => env.id === selectedEnvironmentId) ?? null)
    : null;
  const refreshDockerAvailability = useCallback(async (source: "startup" | "retry" | "poll") => {
    if (dockerCheckInFlightRef.current) return dockerCheckInFlightRef.current;

    const check = (async () => {
      const previous = dockerAvailableRef.current;
      let available = await probeDocker(source);

      // A single failed probe is not evidence of an outage. `check_docker`
      // shells out to `docker info` with a 10s timeout and reports any failure
      // - including that timeout - as "unavailable", so a loaded host can
      // produce a false negative. Tearing down container-backed UI on one of
      // those is destructive, so confirm before believing a daemon that was
      // healthy a moment ago went away.
      for (
        let attempt = 1;
        !available && previous === true && attempt < DOCKER_UNAVAILABLE_CONFIRMATIONS;
        attempt++
      ) {
        available = await probeDocker(source);
      }

      rendererDebugLog(`[App] Docker ${source} check:`, available);
      dockerAvailableRef.current = available;
      setDockerAvailable(available);

      // Reconcile container identities on startup and when Docker comes back,
      // but not on every healthy poll.
      if (available && previous !== true) {
        try {
          const clearedIds = await syncAllEnvironmentsWithDocker();
          if (clearedIds.length > 0) {
            rendererDebugLog("[App] Cleared orphaned container references:", clearedIds);
          }
        } catch (error) {
          console.error("[App] Failed to sync environments with Docker:", error);
          // Non-fatal - Docker-backed controls can still be enabled.
        }
      }

      return available;
    })();

    dockerCheckInFlightRef.current = check;
    try {
      return await check;
    } finally {
      if (dockerCheckInFlightRef.current === check) {
        dockerCheckInFlightRef.current = null;
      }
    }
  }, []);

  // Check Docker availability on startup and sync environments
  useEffect(() => {
    const initDocker = async () => {
      await refreshDockerAvailability("startup");
    };

    void initDocker();
  }, [refreshDockerAvailability]);

  // Docker can be started or stopped while Orkestrator remains open. Keep the
  // shared capability state fresh in both directions without overlapping a
  // slow daemon probe.
  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshDockerAvailability("poll");
    }, DOCKER_AVAILABILITY_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refreshDockerAvailability]);

  // Dismissing an outage should last for that outage. Once Docker recovers, a
  // later outage is new information and should warn the user again.
  useEffect(() => {
    if (dockerAvailable === true) setDockerWarningDismissed(false);
  }, [dockerAvailable]);

  // Host CLI availability is independent of Docker. Run it in parallel with
  // the daemon probe so local worktree workflows receive the same onboarding.
  useEffect(() => {
    Promise.all([
      checkClaudeCli(),
      checkClaudeConfig(),
      checkOpencodeCli(),
      checkCodexCli(),
      checkGithubCli(),
      getAvailableAiCli(),
    ])
      .then(([claudeCli, claudeConfig, opencodeCli, codexCli, githubCli, aiCli]) => {
        rendererDebugLog("[App] Claude CLI available:", claudeCli);
        rendererDebugLog("[App] Claude config available:", claudeConfig);
        rendererDebugLog("[App] OpenCode CLI available:", opencodeCli);
        rendererDebugLog("[App] Codex CLI available:", codexCli);
        rendererDebugLog("[App] GitHub CLI available:", githubCli);
        rendererDebugLog("[App] Available AI CLI:", aiCli);
        setClaudeCliAvailable(claudeCli);
        setClaudeConfigAvailable(claudeConfig);
        setOpencodeCliAvailable(opencodeCli);
        setCodexCliAvailable(codexCli);
        setGithubCliAvailable(githubCli);
        setAvailableAiCli(aiCli);
      })
      .catch((error) => {
        console.error("[App] CLI check failed:", error);
        setClaudeCliAvailable(false);
        setClaudeConfigAvailable(false);
        setOpencodeCliAvailable(false);
        setCodexCliAvailable(false);
        setGithubCliAvailable(false);
        setAvailableAiCli(null);
      });
  }, []);

  // Load config from backend on startup
  // This ensures repository configs (including default port mappings) are available
  // before the user opens any dialogs
  useEffect(() => {
    getConfig()
      .then((config) => {
        setConfig(config);
      })
      .catch((error) => {
        console.error("[App] Failed to load config:", error);
      });
  }, [setConfig]);

  // Handle retrying Docker check
  const handleRetryDockerCheck = async () => {
    setIsCheckingDocker(true);
    try {
      await refreshDockerAvailability("retry");
    } finally {
      setIsCheckingDocker(false);
    }
  };

  const handleCloseApp = async () => {
    try {
      await exit(0);
    } catch (error) {
      console.error("[App] Failed to exit via plugin:", error);
      window.close();
    }
  };

  // Handle retrying CLI checks (Claude, OpenCode, GitHub)
  const handleRetryClaudeCheck = async () => {
    setIsCheckingClaude(true);
    try {
      const [claudeCli, claudeConfig, opencodeCli, codexCli, githubCli, aiCli] = await Promise.all([
        checkClaudeCli(),
        checkClaudeConfig(),
        checkOpencodeCli(),
        checkCodexCli(),
        checkGithubCli(),
        getAvailableAiCli(),
      ]);
      rendererDebugLog(
        "[App] CLI retry check - Claude:",
        claudeCli,
        "OpenCode:",
        opencodeCli,
        "Codex:",
        codexCli,
        "GitHub:",
        githubCli,
        "Available AI:",
        aiCli,
      );
      setClaudeCliAvailable(claudeCli);
      setClaudeConfigAvailable(claudeConfig);
      setOpencodeCliAvailable(opencodeCli);
      setCodexCliAvailable(codexCli);
      setGithubCliAvailable(githubCli);
      setAvailableAiCli(aiCli);
    } catch (error) {
      console.error("[App] CLI retry check failed:", error);
      setClaudeCliAvailable(false);
      setClaudeConfigAvailable(false);
      setOpencodeCliAvailable(false);
      setCodexCliAvailable(false);
      setGithubCliAvailable(false);
      setAvailableAiCli(null);
    } finally {
      setIsCheckingClaude(false);
    }
  };

  // Prefer Chromium's real page zoom in Electron. Unlike CSS `zoom`, native page
  // zoom changes the layout viewport as well as the painted pixels, so the app
  // renders at the device pixel ratio rather than being upscaled. Browser
  // clients fall back to CSS `zoom`, which sizes correctly as long as the shell
  // measures itself against its container instead of viewport units.
  useEffect(() => {
    let active = true;
    const rootStyle = document.documentElement.style;
    const applyCssFallback = () => {
      rootStyle.zoom = `${zoomLevel}%`;
    };

    void getCurrentWindow()
      .setZoomFactor(zoomLevel / 100)
      .then((appliedNatively) => {
        if (!active) return;
        // Clear any fallback left over from a client that could not zoom
        // natively; leaving it set would compound with the native factor.
        if (appliedNatively) rootStyle.zoom = "";
        else applyCssFallback();
      })
      .catch((error) => {
        if (!active) return;
        console.warn("[App] Failed to apply native zoom; using CSS fallback:", error);
        applyCssFallback();
      });

    return () => {
      active = false;
    };
  }, [zoomLevel]);

  // Surface Claude credential refresh/push failures as a non-blocking toast.
  // The backend de-dupes (only emits after repeated failures or actual push
  // problems), but we also guard against toast spam here.
  const lastCredentialToastAt = useRef(0);
  useEffect(() => {
    const unlisten = listen<{ message: string; kind: string }>(
      "claude-credentials-error",
      (event) => {
        const now = Date.now();
        // Suppress repeated toasts within a 5 minute window.
        if (now - lastCredentialToastAt.current < 5 * 60 * 1000) return;
        lastCredentialToastAt.current = now;

        const title =
          event.payload.kind === "refresh_failed"
            ? "Claude credentials refresh failed"
            : "Failed to sync Claude credentials";
        toast.error(title, {
          description: event.payload.message,
          duration: 10_000,
        });
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Listen for menu zoom events from Electron backend
  useEffect(() => {
    const unlisten = listen<string>("menu-zoom", (event) => {
      switch (event.payload) {
        case "in":
          zoomIn();
          break;
        case "out":
          zoomOut();
          break;
        case "reset":
          resetZoom();
          break;
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [zoomIn, zoomOut, resetZoom]);

  // Global keyboard shortcuts for zoom (CMD+/CMD- on Mac, Ctrl+/Ctrl- on Windows/Linux)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Handle CMD (Mac) or Ctrl (Windows/Linux) key combinations
      // Require exactly one modifier key (not both)
      const hasModifier = e.metaKey || e.ctrlKey;
      const hasBothModifiers = e.metaKey && e.ctrlKey;
      if (!hasModifier || hasBothModifiers || e.altKey) return;

      // CMD/Ctrl+= or CMD/Ctrl++ (zoom in)
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomIn();
        return;
      }

      // CMD/Ctrl+- (zoom out)
      if (e.key === "-") {
        e.preventDefault();
        zoomOut();
        return;
      }

      // CMD/Ctrl+0 (reset zoom)
      if (e.key === "0") {
        e.preventDefault();
        resetZoom();
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [zoomIn, zoomOut, resetZoom]);

  // Derived state for dialog visibility - makes conditions easier to read
  // When Docker is down, let its outage warning lead; host-tool onboarding is
  // shown after the user chooses to continue without containers.
  const hostToolWarningsVisible =
    dockerAvailable === true || (dockerAvailable === false && dockerWarningDismissed);

  const isCheckingCliTools =
    hostToolWarningsVisible && availableAiCli === null && claudeCliAvailable === null;

  const noAiCliAvailable =
    hostToolWarningsVisible &&
    claudeCliAvailable === false &&
    opencodeCliAvailable === false &&
    codexCliAvailable === false;

  const claudeNeedsLogin =
    hostToolWarningsVisible &&
    claudeCliAvailable === true &&
    claudeConfigAvailable === false &&
    opencodeCliAvailable === false;

  const showGithubWarning =
    hostToolWarningsVisible &&
    (claudeCliAvailable === true || opencodeCliAvailable === true) &&
    githubCliAvailable === false &&
    !githubCliWarningDismissed;

  const handleStartEnvironmentFromOverlay = useCallback(
    async (environmentId: string, initialPrompt?: string): Promise<boolean> => {
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
      const existingOptions = useClaudeOptionsStore.getState().getOptions(environmentId);

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
         * would run a prompt whose images are missing.
         */
        const attachmentState = environment?.hasInitialPromptAttachments;
        if (existingOptions?.initialPromptAttachments === undefined && attachmentState !== false) {
          try {
            const loadedEnvironment = await getEnvironment(environmentId);
            if (!loadedEnvironment) {
              throw new Error(`Environment ${environmentId} was not found`);
            }
            detailedEnvironment = loadedEnvironment;
          } catch (error) {
            console.error(
              "[App] Failed to restore saved prompt attachments before startup:",
              error,
            );
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
            previewUrl: attachment.previewUrl ?? `data:image/png;base64,${attachment.base64Data}`,
          }),
        );
        setClaudeOptions(environmentId, {
          launchAgent: true,
          agentType:
            existingOptions?.agentType ??
            resolvedDefaultAgent(config, environment?.projectId, environment),
          initialPrompt: launchPrompt,
          initialPromptAttachments: existingOptions?.initialPromptAttachments ?? storedAttachments,
        });
      } else if (existingOptions?.initialPrompt?.trim()) {
        clearClaudeOptions(environmentId);
      }

      try {
        // Setup command handling (blocking, placeholder, resolve) is centralized
        // in useEnvironments.startEnvironment() for all code paths.
        await startEnvironment(environmentId, launchPrompt);
        return true;
      } catch (error) {
        console.error("[App] Failed to start environment from terminal overlay:", error);
        return false;
      }
    },
    [
      clearClaudeOptions,
      config,
      dockerAvailable,
      getEnvironmentById,
      setClaudeOptions,
      startEnvironment,
    ],
  );

  const handleCreateScriptFromOverlay = useCallback(
    async (environmentId: string, initialPrompt: string) => {
      const environment = getEnvironmentById(environmentId);
      const agentType = resolvedDefaultAgent(config, environment?.projectId, environment);

      setClaudeOptions(environmentId, {
        launchAgent: true,
        agentType,
        initialPrompt,
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

  return (
    <TooltipProvider>
      <TerminalProvider>
        <DockerAvailabilityProvider available={dockerAvailable === true}>
          <AppShell>
            {selectedEnvironment ? (
              <div className="relative h-full bg-background">
                <div className="absolute inset-0 z-10 bg-background">
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
                  />
                </div>
              </div>
            ) : selectedProjectId ? (
              <KanbanBoard projectId={selectedProjectId} />
            ) : (
              <ProjectLauncher
                createEnvironment={createEnvironment}
                updateEnvironment={updateEnvironment}
                startEnvironment={startEnvironment}
              />
            )}
          </AppShell>
        </DockerAvailabilityProvider>
        <Toaster />
        <ErrorDetailsDialog />

        {/* Loading overlay while checking Docker */}
        {dockerAvailable === null && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Checking Docker availability...</p>
            </div>
          </div>
        )}

        {/* Loading overlay while checking CLI tools (after Docker is confirmed) */}
        {isCheckingCliTools && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Checking CLI tools installation...</p>
            </div>
          </div>
        )}

        {/* Docker not available dialog */}
        <AlertDialog
          open={dockerAvailable === false && !dockerWarningDismissed}
          onOpenChange={(open) => {
            if (!open) setDockerWarningDismissed(true);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Docker Is Not Running</AlertDialogTitle>
              <AlertDialogDescription>
                Container functionality is currently disabled. You can continue using local worktree
                environments while Docker is unavailable.
                <br />
                <br />
                Start Docker, or install Docker Desktop from{" "}
                <a
                  href="https://docker.com"
                  className="text-primary underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  docker.com
                </a>
                . Orkestrator will check again automatically every 60 seconds.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button
                variant="outline"
                onClick={handleRetryDockerCheck}
                disabled={isCheckingDocker}
              >
                {isCheckingDocker ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Checking...
                  </>
                ) : (
                  "Check Again"
                )}
              </Button>
              <AlertDialogAction onClick={() => setDockerWarningDismissed(true)}>
                Continue Without Docker
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* AI CLI not installed dialog - shows when Claude, Codex, and OpenCode are unavailable */}
        <AlertDialog open={noAiCliAvailable}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>AI CLI Required</AlertDialogTitle>
              <AlertDialogDescription>
                No compatible AI CLI is installed on your system. Orkestrator AI requires Claude
                Code, Codex, or OpenCode to create and manage AI-powered development environments.
                <br />
                <br />
                <strong>Option 1: Install Claude Code (recommended)</strong>
                <pre className="my-2 rounded bg-muted p-2 text-sm font-mono">
                  curl -fsSL https://claude.ai/install.sh | bash
                </pre>
                Then run <code className="rounded bg-muted px-1 font-mono">claude</code> to complete
                the setup.
                <br />
                <br />
                <strong>Option 2: Install Codex</strong>
                <pre className="my-2 rounded bg-muted p-2 text-sm font-mono">
                  npm install -g @openai/codex
                </pre>
                <br />
                <br />
                <strong>Option 3: Install OpenCode</strong>
                <pre className="my-2 rounded bg-muted p-2 text-sm font-mono">
                  curl -fsSL https://opencode.ai/install | bash
                </pre>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button
                variant="outline"
                onClick={handleRetryClaudeCheck}
                disabled={isCheckingClaude}
              >
                {isCheckingClaude ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Checking...
                  </>
                ) : (
                  "Retry"
                )}
              </Button>
              <Button onClick={handleCloseApp}>Close Application</Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Claude Code not logged in dialog - only shows when Claude is available but not logged in, and OpenCode is NOT available as fallback */}
        <AlertDialog open={claudeNeedsLogin}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Claude Code Login Required</AlertDialogTitle>
              <AlertDialogDescription>
                Claude Code is installed but you haven't logged in yet. Please log in to continue.
                <br />
                <br />
                Run the following command in your terminal:
                <pre className="my-2 rounded bg-muted p-2 text-sm font-mono">claude</pre>
                This will open a browser window to authenticate with your Anthropic account.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button
                variant="outline"
                onClick={handleRetryClaudeCheck}
                disabled={isCheckingClaude}
              >
                {isCheckingClaude ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Checking...
                  </>
                ) : (
                  "Retry"
                )}
              </Button>
              <Button onClick={handleCloseApp}>Close Application</Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* GitHub CLI warning dialog - non-blocking, dismissible */}
        <AlertDialog open={showGithubWarning}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>GitHub CLI Not Found</AlertDialogTitle>
              <AlertDialogDescription>
                The GitHub CLI (gh) is not installed on your system. While not required, it enables
                features like PR detection and GitHub integration.
                <br />
                <br />
                <strong>Install GitHub CLI:</strong>
                <br />
                <br />
                <strong>macOS (Homebrew):</strong>
                <pre className="my-2 rounded bg-muted p-2 text-sm font-mono">brew install gh</pre>
                <strong>Linux:</strong>
                <pre className="my-2 rounded bg-muted p-2 text-sm font-mono">
                  sudo apt install gh # Debian/Ubuntu{"\n"}sudo dnf install gh # Fedora
                </pre>
                <strong>Windows:</strong>
                <pre className="my-2 rounded bg-muted p-2 text-sm font-mono">
                  winget install GitHub.cli
                </pre>
                After installation, run{" "}
                <code className="rounded bg-muted px-1 font-mono">gh auth login</code> to
                authenticate.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button
                variant="outline"
                onClick={handleRetryClaudeCheck}
                disabled={isCheckingClaude}
              >
                {isCheckingClaude ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Checking...
                  </>
                ) : (
                  "Retry"
                )}
              </Button>
              <AlertDialogAction onClick={() => setGithubCliWarningDismissed(true)}>
                Continue Without GitHub CLI
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </TerminalProvider>
    </TooltipProvider>
  );
}

export default App;
