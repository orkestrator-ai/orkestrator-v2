import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { exit } from "@tauri-apps/plugin-process";
import { toast } from "sonner";
import { AppShell } from "@/components/layout";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TerminalContainer } from "@/components/terminal";
import { KanbanBoard } from "@/components/kanban";
import { TerminalProvider } from "@/contexts";
import {
  getAllLeaves,
  useUIStore,
  useEnvironmentStore,
  useConfigStore,
  useClaudeOptionsStore,
  usePaneLayoutStore,
} from "@/stores";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useClaudeStore } from "@/stores/claudeStore";
import { useCodexStore } from "@/stores/codexStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import { getBackgroundProcessingEnvironments } from "@/lib/background-pipelines";
import { cn, getEnvironmentIdFromSessionKey } from "@/lib/utils";
import { Toaster } from "@/components/ui/sonner";
import { ErrorDetailsDialog } from "@/components/errors";
import { checkDocker, checkClaudeCli, checkClaudeConfig, checkCodexCli, checkOpencodeCli, checkGithubCli, getAvailableAiCli, getConfig, syncAllEnvironmentsWithDocker } from "@/lib/tauri";
import { usePrMonitorService } from "@/hooks/usePrMonitorService";
import { useGlobalActivityMonitor } from "@/hooks/useGlobalActivityMonitor";
import { useEnvironments } from "@/hooks";
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

function App() {
  const { selectedEnvironmentId, selectedProjectId, zoomLevel, zoomIn, zoomOut, resetZoom } = useUIStore();
  const environments = useEnvironmentStore((state) => state.environments);
  const getEnvironmentById = useEnvironmentStore((state) => state.getEnvironmentById);
  const setConfig = useConfigStore((state) => state.setConfig);
  const config = useConfigStore((state) => state.config);
  const setClaudeOptions = useClaudeOptionsStore((state) => state.setOptions);
  const clearClaudeOptions = useClaudeOptionsStore((state) => state.clearOptions);
  const { startEnvironment } = useEnvironments(null, { listenForRenameEvents: false });
  const [dockerAvailable, setDockerAvailable] = useState<boolean | null>(null);
  const [isCheckingDocker, setIsCheckingDocker] = useState(false);

  // Initialize centralized PR monitoring service
  usePrMonitorService();
  // Monitor agent activity for ALL environments (regardless of selected project)
  useGlobalActivityMonitor();
  const [claudeCliAvailable, setClaudeCliAvailable] = useState<boolean | null>(null);
  const [claudeConfigAvailable, setClaudeConfigAvailable] = useState<boolean | null>(null);
  const [opencodeCliAvailable, setOpencodeCliAvailable] = useState<boolean | null>(null);
  const [codexCliAvailable, setCodexCliAvailable] = useState<boolean | null>(null);
  const [githubCliAvailable, setGithubCliAvailable] = useState<boolean | null>(null);
  const [availableAiCli, setAvailableAiCli] = useState<string | null>(null);
  const [isCheckingClaude, setIsCheckingClaude] = useState(false);
  const [githubCliWarningDismissed, setGithubCliWarningDismissed] = useState(false);

  const projectEnvironments = selectedProjectId
    ? environments.filter((env) => env.projectId === selectedProjectId)
    : [];
  const setupScriptsRunning = useEnvironmentStore((state) => state.setupScriptsRunning);
  const pendingNativeLaunches = useClaudeOptionsStore((state) => state.pendingNativeLaunches);
  const paneLayoutEnvironments = usePaneLayoutStore((state) => state.environments);
  const pendingInitialPromptEnvironmentIds = useMemo(() => {
    const environmentIds: string[] = [];
    for (const [environmentId, paneState] of paneLayoutEnvironments) {
      const hasPendingInitialPrompt = getAllLeaves(paneState.root)
        .some((leaf) => leaf.tabs.some((tab) => !!tab.initialPrompt?.trim()));
      if (hasPendingInitialPrompt) {
        environmentIds.push(environmentId);
      }
    }
    return environmentIds;
  }, [paneLayoutEnvironments]);

  // Loading or queued native sessions across Claude/Codex/OpenCode keep their
  // environment mounted so SSE subscriptions, watchdog polls, and queue drains
  // can advance even when the user has navigated elsewhere.
  const claudeSessions = useClaudeStore((state) => state.sessions);
  const codexSessions = useCodexStore((state) => state.sessions);
  const openCodeSessions = useOpenCodeStore((state) => state.sessions);
  const claudeMessageQueue = useClaudeStore((state) => state.messageQueue);
  const codexMessageQueue = useCodexStore((state) => state.messageQueue);
  const openCodeMessageQueue = useOpenCodeStore((state) => state.messageQueue);
  const loadingNativeSessionEnvironmentIds = useMemo(() => {
    const environmentIds = new Set<string>();
    const sessionMaps = [claudeSessions, codexSessions, openCodeSessions];
    for (const sessionMap of sessionMaps) {
      for (const [sessionKey, session] of sessionMap) {
        if (!session.isLoading) continue;
        const environmentId = getEnvironmentIdFromSessionKey(sessionKey);
        if (environmentId) {
          environmentIds.add(environmentId);
        }
      }
    }
    return Array.from(environmentIds);
  }, [claudeSessions, codexSessions, openCodeSessions]);
  const queuedNativePromptEnvironmentIds = useMemo(() => {
    const environmentIds = new Set<string>();
    const queueMaps = [claudeMessageQueue, codexMessageQueue, openCodeMessageQueue];
    for (const queueMap of queueMaps) {
      for (const [sessionKey, queue] of queueMap) {
        if (queue.length === 0) continue;
        const environmentId = getEnvironmentIdFromSessionKey(sessionKey);
        if (environmentId) {
          environmentIds.add(environmentId);
        }
      }
    }
    return Array.from(environmentIds);
  }, [claudeMessageQueue, codexMessageQueue, openCodeMessageQueue]);

  // Environments with active background processing that aren't currently visible
  // in the main content. These must stay mounted so setup completion detection,
  // native initial prompts, in-flight or queued native sessions, terminal
  // listeners, SSE subscriptions, and pipeline advancement effects continue
  // running even when the user navigates away.
  const pipelines = useBuildPipelineStore((state) => state.pipelines);
  const backgroundProcessingEnvironments = useMemo(
    () => getBackgroundProcessingEnvironments(
      pipelines,
      environments,
      selectedEnvironmentId,
      projectEnvironments,
      setupScriptsRunning,
      Object.keys(pendingNativeLaunches),
      pendingInitialPromptEnvironmentIds,
      loadingNativeSessionEnvironmentIds,
      queuedNativePromptEnvironmentIds,
    ),
    [
      pipelines,
      environments,
      selectedEnvironmentId,
      projectEnvironments,
      setupScriptsRunning,
      pendingNativeLaunches,
      pendingInitialPromptEnvironmentIds,
      loadingNativeSessionEnvironmentIds,
      queuedNativePromptEnvironmentIds,
    ],
  );

  // Debug logging
  console.log("[App] selectedEnvironmentId:", selectedEnvironmentId);
  console.log("[App] selectedProjectId:", selectedProjectId);
  console.log("[App] projectEnvironments:", projectEnvironments.length);

  const refreshDockerAvailability = useCallback(async (source: "startup" | "retry") => {
    const available = await checkDocker();
    console.log(`[App] Docker ${source} check:`, available);
    setDockerAvailable(available);

    if (!available) return available;

    try {
      const clearedIds = await syncAllEnvironmentsWithDocker();
      if (clearedIds.length > 0) {
        console.log("[App] Cleared orphaned container references:", clearedIds);
      }
    } catch (error) {
      console.error("[App] Failed to sync environments with Docker:", error);
      // Non-fatal - continue with app startup
    }

    return available;
  }, []);

  // Check Docker availability on startup and sync environments
  useEffect(() => {
    const initDocker = async () => {
      try {
        await refreshDockerAvailability("startup");
      } catch (error) {
        console.error("[App] Docker check failed:", error);
        setDockerAvailable(false);
      }
    };

    initDocker();
  }, [refreshDockerAvailability]);

  // Check CLI availability after Docker is confirmed available
  // Checks: Claude CLI, OpenCode CLI (fallback), and GitHub CLI
  useEffect(() => {
    if (dockerAvailable !== true) return;

    Promise.all([
      checkClaudeCli(),
      checkClaudeConfig(),
      checkOpencodeCli(),
      checkCodexCli(),
      checkGithubCli(),
      getAvailableAiCli(),
    ])
      .then(([claudeCli, claudeConfig, opencodeCli, codexCli, githubCli, aiCli]) => {
        console.log("[App] Claude CLI available:", claudeCli);
        console.log("[App] Claude config available:", claudeConfig);
        console.log("[App] OpenCode CLI available:", opencodeCli);
        console.log("[App] Codex CLI available:", codexCli);
        console.log("[App] GitHub CLI available:", githubCli);
        console.log("[App] Available AI CLI:", aiCli);
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
  }, [dockerAvailable]);

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

  // Handle closing the app when Docker is not available
  const handleCloseApp = async () => {
    try {
      await exit(0);
    } catch (error) {
      console.error("[App] Failed to exit via plugin:", error);
      // Fallback: try using window.close() for webview
      window.close();
    }
  };

  // Handle retrying Docker check
  const handleRetryDockerCheck = async () => {
    setIsCheckingDocker(true);
    try {
      await refreshDockerAvailability("retry");
    } catch (error) {
      console.error("[App] Docker retry check failed:", error);
      setDockerAvailable(false);
    } finally {
      setIsCheckingDocker(false);
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
      console.log("[App] CLI retry check - Claude:", claudeCli, "OpenCode:", opencodeCli, "Codex:", codexCli, "GitHub:", githubCli, "Available AI:", aiCli);
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

  // Apply zoom level to the document
  useEffect(() => {
    document.documentElement.style.zoom = `${zoomLevel}%`;
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
      }
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Listen for menu zoom events from Tauri backend
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
  const isCheckingCliTools =
    dockerAvailable === true &&
    availableAiCli === null &&
    claudeCliAvailable === null;

  const noAiCliAvailable =
    dockerAvailable === true &&
    claudeCliAvailable === false &&
    opencodeCliAvailable === false &&
    codexCliAvailable === false;

  const claudeNeedsLogin =
    dockerAvailable === true &&
    claudeCliAvailable === true &&
    claudeConfigAvailable === false &&
    opencodeCliAvailable === false;

  const showGithubWarning =
    dockerAvailable === true &&
    (claudeCliAvailable === true || opencodeCliAvailable === true) &&
    githubCliAvailable === false &&
    !githubCliWarningDismissed;

  const handleStartEnvironmentFromOverlay = useCallback(
    async (environmentId: string, initialPrompt?: string): Promise<boolean> => {
      // Clear any stale queued agent launch for normal starts.
      if (!initialPrompt) {
        clearClaudeOptions(environmentId);
      }

      try {
        // Setup command handling (blocking, placeholder, resolve) is centralized
        // in useEnvironments.startEnvironment() for all code paths.
        await startEnvironment(environmentId, initialPrompt);
        return true;
      } catch (error) {
        console.error("[App] Failed to start environment from terminal overlay:", error);
        return false;
      }
    },
    [clearClaudeOptions, startEnvironment]
  );

  // Stable no-op callbacks for background pipeline environments (avoids new references each render)
  const noop = useCallback(() => {}, []);

  const handleCreateScriptFromOverlay = useCallback(
    async (environmentId: string, initialPrompt: string) => {
      const environment = getEnvironmentById(environmentId);
      const agentType = environment?.defaultAgent || config.global.defaultAgent || "claude";

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
    [clearClaudeOptions, config.global.defaultAgent, getEnvironmentById, handleStartEnvironmentFromOverlay, setClaudeOptions]
  );

  return (
    <TooltipProvider>
      <TerminalProvider>
        <AppShell>
          {selectedEnvironmentId ? (
            <div className="relative h-full bg-background">
              {projectEnvironments.map((environment) => {
                const isActive = environment.id === selectedEnvironmentId;
                return (
                  <div
                    key={environment.id}
                    className={cn(
                      "absolute inset-0 bg-background",
                      // Active environment gets higher z-index to ensure it's on top
                      // and receives all pointer events. Inactive environments are
                      // hidden and non-interactive.
                      isActive ? "z-10" : "z-0 opacity-0 pointer-events-none"
                    )}
                  >
                    <TerminalContainer
                      environmentId={environment.id}
                      containerId={environment.containerId ?? null}
                      isContainerRunning={environment.status === "running"}
                      isContainerCreating={environment.status === "creating"}
                      isActive={isActive}
                      className="h-full"
                      onStartContainer={(initialPrompt) => {
                        void handleStartEnvironmentFromOverlay(environment.id, initialPrompt);
                      }}
                      onCreateScript={(initialPrompt) => {
                        void handleCreateScriptFromOverlay(environment.id, initialPrompt);
                      }}
                    />
                  </div>
                );
              })}
            </div>
          ) : selectedProjectId ? (
            <KanbanBoard projectId={selectedProjectId} />
          ) : (
            <div className="flex h-full items-center justify-center bg-background">
              <div className="text-center text-muted-foreground">
                <h2 className="mb-2 text-lg font-medium">Welcome to Orkestrator AI</h2>
                <p className="text-sm">
                  Add a project to get started, then create an environment to begin coding.
                </p>
              </div>
            </div>
          )}

          {/* Background pipeline environments: kept mounted (but hidden) so their
              SSE subscriptions and pipeline-advancement effects continue running
              even when the user navigates to a different project or kanban view. */}
          {backgroundProcessingEnvironments.length > 0 && (
            <div className="hidden" aria-hidden="true">
              {backgroundProcessingEnvironments.map((environment) => (
                <TerminalContainer
                  key={`bg-pipeline-${environment.id}`}
                  environmentId={environment.id}
                  containerId={environment.containerId ?? null}
                  isContainerRunning={environment.status === "running"}
                  isContainerCreating={environment.status === "creating"}
                  isActive={false}
                  className="h-full"
                  onStartContainer={noop}
                  onCreateScript={noop}
                />
              ))}
            </div>
          )}
        </AppShell>
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
        <AlertDialog open={dockerAvailable === false}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Docker Required</AlertDialogTitle>
              <AlertDialogDescription>
                Docker is not running or not installed on your system. Orkestrator AI requires Docker to create and manage development environments.
                <br /><br />
                Please install Docker Desktop from{" "}
                <a
                  href="https://docker.com"
                  className="text-primary underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  docker.com
                </a>{" "}
                and ensure it is running before starting the application.
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
                  "Retry"
                )}
              </Button>
              <Button onClick={handleCloseApp}>
                Close Application
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* AI CLI not installed dialog - shows when Claude, OpenCode, and Codex are unavailable */}
        <AlertDialog open={noAiCliAvailable}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>AI CLI Required</AlertDialogTitle>
              <AlertDialogDescription>
                No compatible AI CLI is installed on your system. Orkestrator AI requires Claude Code, OpenCode, or Codex to create and manage AI-powered development environments.
                <br /><br />
                <strong>Option 1: Install Claude Code (recommended)</strong>
                <pre className="my-2 rounded bg-muted p-2 text-sm font-mono">curl -fsSL https://claude.ai/install.sh | bash</pre>
                Then run <code className="rounded bg-muted px-1 font-mono">claude</code> to complete the setup.
                <br /><br />
                <strong>Option 2: Install OpenCode</strong>
                <pre className="my-2 rounded bg-muted p-2 text-sm font-mono">curl -fsSL https://opencode.ai/install | bash</pre>
                <br /><br />
                <strong>Option 3: Install Codex</strong>
                <pre className="my-2 rounded bg-muted p-2 text-sm font-mono">npm install -g @openai/codex</pre>
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
              <Button onClick={handleCloseApp}>
                Close Application
              </Button>
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
                <br /><br />
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
              <Button onClick={handleCloseApp}>
                Close Application
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* GitHub CLI warning dialog - non-blocking, dismissible */}
        <AlertDialog open={showGithubWarning}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>GitHub CLI Not Found</AlertDialogTitle>
              <AlertDialogDescription>
                The GitHub CLI (gh) is not installed on your system. While not required, it enables features like PR detection and GitHub integration.
                <br /><br />
                <strong>Install GitHub CLI:</strong>
                <br /><br />
                <strong>macOS (Homebrew):</strong>
                <pre className="my-2 rounded bg-muted p-2 text-sm font-mono">brew install gh</pre>
                <strong>Linux:</strong>
                <pre className="my-2 rounded bg-muted p-2 text-sm font-mono">sudo apt install gh  # Debian/Ubuntu{"\n"}sudo dnf install gh  # Fedora</pre>
                <strong>Windows:</strong>
                <pre className="my-2 rounded bg-muted p-2 text-sm font-mono">winget install GitHub.cli</pre>
                After installation, run <code className="rounded bg-muted px-1 font-mono">gh auth login</code> to authenticate.
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
