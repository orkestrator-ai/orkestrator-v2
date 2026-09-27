import {
  agentSettingsTiers,
  resolvedActionDefault,
  resolvedDefaultAgent,
} from "@/lib/agent-settings";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listen } from "@/lib/native/events";
import { exit, restart } from "@/lib/native/process";
import { getCurrentWindow } from "@/lib/native/window";
import { toast } from "sonner";
import { AppShell } from "@/components/layout";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TerminalContainer } from "@/components/terminal";
import { ProjectLauncher, ProjectWorkspace } from "@/components/projects";
import { TerminalProvider } from "@/contexts";
import { useUIStore, useEnvironmentStore, useConfigStore, useClaudeOptionsStore } from "@/stores";
import { useProjectStore } from "@/stores/projectStore";
import { startPaneLayoutPersistence } from "@/lib/pane-layout-persistence";
import { setReadCoordinatorConnection } from "@/lib/read-coordinator";
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
  getScopedResourceRevisionManifest,
  getScopedResourceSnapshots,
  prepareEnvironmentAgentLaunch,
  syncAllEnvironmentsWithDocker,
} from "@/lib/backend";
import { usePrMonitorService } from "@/hooks/usePrMonitorService";
import { useGlobalActivityMonitor } from "@/hooks/useGlobalActivityMonitor";
import { useUnreadEnvironmentSync } from "@/hooks/useUnreadEnvironmentSync";
import { useNotificationSoundService } from "@/hooks/useNotificationSoundService";
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
import type {
  DockerAvailability,
  DockerUnavailableReason,
} from "@orkestrator/protocol/docker-availability";
import { LOCAL_CONNECTION_ID, type ConnectionList } from "@orkestrator/protocol/connections";
import {
  hasBlockingMacOsPermissions,
  type MacOsPermissionsStatus,
  type MacOsPrivacySettingsPane,
} from "@orkestrator/protocol/macos-permissions";
import { subscribeToConnections } from "@/lib/connections";

export const DOCKER_AVAILABILITY_POLL_INTERVAL_MS = 60_000;
export const DOCKER_STARTUP_CONFIRMATION_DELAY_MS = 1_500;
export const HOST_TOOL_STARTUP_CONFIRMATION_DELAY_MS = 250;

type StartupCheckStatus = "checking" | "complete" | "error";

function desktopConnectionScopeSeed(): {
  activeConnectionId: string | null;
  resolved: boolean;
} {
  if (!window.orkestrator?.connections) {
    return { activeConnectionId: null, resolved: true };
  }
  if (window.orkestratorGateway?.desktop && window.orkestratorGateway.baseUrl) {
    return { activeConnectionId: window.orkestratorGateway.baseUrl, resolved: true };
  }
  return { activeConnectionId: null, resolved: false };
}

/**
 * How many consecutive failed probes it takes to confirm a transient Docker
 * outage. Startup keeps the bounded loading state visible for an updater-
 * sensitive missing-binary result; other diagnostics remain non-blocking while
 * confirmation runs. A daemon that was already seen healthy stays available
 * until the confirmation completes.
 */
export const DOCKER_UNAVAILABLE_CONFIRMATIONS = 2;

/**
 * A single daemon probe, normalised to a structured result. It never rejects -
 * the poll would otherwise leave an unhandled rejection behind. The boolean
 * fallback keeps the renderer compatible with an older backend during a dev
 * hot reload.
 */
async function probeDocker(
  source: "startup" | "retry" | "poll",
): Promise<DockerAvailability | null> {
  try {
    const result: DockerAvailability | boolean = await checkDocker();
    if (typeof result === "boolean") {
      return result
        ? { available: true, reason: null }
        : { available: false, reason: "daemon-unavailable" };
    }
    return result;
  } catch (error) {
    console.error(`[App] Docker ${source} check failed:`, error);
    // A failed request says nothing about Docker. In particular, treating an
    // IPC/gateway startup race as `available: false` used to produce both the
    // Docker warning and the AI CLI onboarding dialog after an app upgrade.
    return null;
  }
}

function waitForDockerStartupConfirmation(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, DOCKER_STARTUP_CONFIRMATION_DELAY_MS);
  });
}

function waitForHostToolStartupConfirmation(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, HOST_TOOL_STARTUP_CONFIRMATION_DELAY_MS);
  });
}

function dockerUnavailableMessage(reason: DockerUnavailableReason | null): {
  title: string;
  description: ReactNode;
} {
  if (reason === "permission-denied") {
    return {
      title: "Docker Permission Required",
      description: (
        <>
          Orkestrator found Docker, but your user account cannot access the Docker daemon. On Linux,
          prefer rootless Docker when available. Otherwise, be aware that Docker group membership
          grants root-level host access. To grant that access, run{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
            sudo usermod -aG docker &quot;$USER&quot;
          </code>
          , then sign out and back in before restarting Orkestrator.
        </>
      ),
    };
  }
  if (reason === "not-installed") {
    return {
      title: "Docker Is Not Installed",
      description: "Install Docker, then restart Orkestrator to use container environments.",
    };
  }
  if (reason === "timed-out") {
    return {
      title: "Docker Check Timed Out",
      description:
        "Docker did not respond within 10 seconds. Check the Docker service and try again.",
    };
  }
  if (reason === "unknown") {
    return {
      title: "Docker Is Unavailable",
      description:
        "Orkestrator found Docker, but `docker info` failed. Run `docker info` in a terminal for more details, then try again.",
    };
  }
  return {
    title: "Docker Is Not Running",
    description: "Start the Docker service or Docker Desktop, then try again.",
  };
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
  const [dockerUnavailableReason, setDockerUnavailableReason] =
    useState<DockerUnavailableReason | null>(null);
  const [isCheckingDocker, setIsCheckingDocker] = useState(false);
  const [dockerWarningDismissed, setDockerWarningDismissed] = useState(false);
  const [dockerCheckStatus, setDockerCheckStatus] = useState<StartupCheckStatus>("checking");
  const dockerAvailableRef = useRef<boolean | null>(null);
  const dockerCheckInFlightRef = useRef<Promise<boolean> | null>(null);
  const [macOsPermissions, setMacOsPermissions] = useState<MacOsPermissionsStatus | null>(() =>
    window.orkestrator?.permissions ? null : { supported: false, missing: [] },
  );
  const [isCheckingMacOsPermissions, setIsCheckingMacOsPermissions] = useState(
    Boolean(window.orkestrator?.permissions),
  );
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(
    () => desktopConnectionScopeSeed().activeConnectionId,
  );
  const [connectionScopeResolved, setConnectionScopeResolved] = useState(
    () => desktopConnectionScopeSeed().resolved,
  );
  const [macOsAdvisoryDismissed, setMacOsAdvisoryDismissed] = useState(false);
  const macOsRefreshGenerationRef = useRef(0);

  // Initialize centralized PR monitoring service
  usePrMonitorService();
  // Monitor agent activity for ALL environments (regardless of selected project)
  useGlobalActivityMonitor();
  // Sounds follow backend-owned unread transitions, even when an environment
  // or agent tab is not mounted in the foreground.
  useNotificationSoundService();
  // Single registration for setup lifecycle events and resume/reconnect
  // reconciliation (previously duplicated per useEnvironments call site).
  useEnvironmentLifecycleService();
  // Opening an environment clears its unread badge for every client.
  useUnreadEnvironmentSync();
  // The backend change feed must be attached before the store bindings that
  // consume it, and both before anything that reads a backend snapshot.
  useEffect(
    () =>
      startResourceSync({
        loadManifest: getResourceRevisionManifest,
        loadScopedManifest: getScopedResourceRevisionManifest,
        loadScopedSnapshots: getScopedResourceSnapshots,
      }),
    [],
  );
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
  const [hostToolCheckStatus, setHostToolCheckStatus] = useState<StartupCheckStatus>("checking");
  const [isCheckingClaude, setIsCheckingClaude] = useState(false);
  const [githubCliWarningDismissed, setGithubCliWarningDismissed] = useState(false);
  const [localBackendUnavailableMessage, setLocalBackendUnavailableMessage] = useState<
    string | null
  >(null);

  useEffect(() => {
    const connectionsApi = window.orkestrator?.connections;
    if (!connectionsApi) return;
    let active = true;
    const applyConnectionList = (list: ConnectionList) => {
      if (!active) return;
      setActiveConnectionId(list.activeConnectionId);
      // Presentation reads are keyed by server identity; a switch resets them.
      setReadCoordinatorConnection(list.activeConnectionId);
      setConnectionScopeResolved(true);
      setLocalBackendUnavailableMessage(
        list.activeConnectionId === LOCAL_CONNECTION_ID && list.localAvailable === false
          ? "The Local backend stopped. Restart Orkestrator to recover local work."
          : null,
      );
    };
    void connectionsApi
      .list()
      .then(applyConnectionList)
      .catch(() => {
        if (!active) return;
        setActiveConnectionId(LOCAL_CONNECTION_ID);
        setConnectionScopeResolved(true);
      });
    const unsubscribeConnections = subscribeToConnections(applyConnectionList);
    const listenDesktop = window.orkestrator?.listen;
    const unsubscribeUnavailable =
      typeof listenDesktop === "function"
        ? listenDesktop<{ message?: string }>("local-backend-unavailable", (payload) => {
            if (!active) return;
            setLocalBackendUnavailableMessage(
              payload.message
                ? `The Local backend stopped: ${payload.message}`
                : "The Local backend stopped. Restart Orkestrator to recover local work.",
            );
          })
        : undefined;
    return () => {
      active = false;
      unsubscribeConnections();
      unsubscribeUnavailable?.();
    };
  }, []);

  const selectedEnvironment = selectedEnvironmentId
    ? (environments.find((env) => env.id === selectedEnvironmentId) ?? null)
    : null;
  const refreshMacOsPermissions = useCallback(async () => {
    const permissionsApi = window.orkestrator?.permissions;
    if (!permissionsApi) {
      setMacOsPermissions({ supported: false, missing: [] });
      setIsCheckingMacOsPermissions(false);
      return;
    }

    const generation = ++macOsRefreshGenerationRef.current;
    setIsCheckingMacOsPermissions(true);
    try {
      const status = await permissionsApi.getMacOsStatus();
      if (generation !== macOsRefreshGenerationRef.current) return;
      setMacOsPermissions(status);
    } catch (error) {
      console.error("[App] Failed to check macOS file permissions:", error);
      if (generation !== macOsRefreshGenerationRef.current) return;
      setMacOsPermissions({
        supported: true,
        missing: [],
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (generation === macOsRefreshGenerationRef.current) {
        setIsCheckingMacOsPermissions(false);
      }
    }
  }, []);
  const isRemoteBackendWindow =
    connectionScopeResolved &&
    activeConnectionId !== null &&
    activeConnectionId !== LOCAL_CONNECTION_ID;
  const macOsProbeFailed = Boolean(macOsPermissions?.error);
  const macOsHasBlockingMissing =
    macOsPermissions !== null && hasBlockingMacOsPermissions(macOsPermissions);
  const macOsHasAdvisoryMissing = Boolean(
    macOsPermissions?.supported &&
    macOsPermissions.missing.some((permission) => permission.id === "full-disk-access"),
  );
  const macOsPermissionsReady =
    isRemoteBackendWindow ||
    (connectionScopeResolved &&
      macOsPermissions !== null &&
      !macOsProbeFailed &&
      (!macOsPermissions.supported ||
        (!macOsHasBlockingMissing && (!macOsHasAdvisoryMissing || macOsAdvisoryDismissed))));
  const showMacOsPermissionGate =
    connectionScopeResolved &&
    !isRemoteBackendWindow &&
    (macOsPermissions === null ||
      macOsProbeFailed ||
      macOsHasBlockingMissing ||
      (macOsHasAdvisoryMissing && !macOsAdvisoryDismissed));
  const showStartupBlocker = !connectionScopeResolved || showMacOsPermissionGate;

  useEffect(() => {
    if (!window.orkestrator?.permissions) return;
    if (!connectionScopeResolved) return;
    if (isRemoteBackendWindow) {
      setMacOsPermissions({ supported: false, missing: [] });
      setIsCheckingMacOsPermissions(false);
      return;
    }
    void refreshMacOsPermissions();
    return () => {
      macOsRefreshGenerationRef.current += 1;
    };
  }, [refreshMacOsPermissions, connectionScopeResolved, isRemoteBackendWindow]);

  const refreshDockerAvailability = useCallback(async (source: "startup" | "retry" | "poll") => {
    if (dockerCheckInFlightRef.current) return dockerCheckInFlightRef.current;

    const check = (async () => {
      const previous = dockerAvailableRef.current;
      if (source !== "poll") setDockerCheckStatus("checking");
      let result = await probeDocker(source);

      if (result === null && source === "startup") {
        await waitForDockerStartupConfirmation();
        result = await probeDocker(source);
      }
      if (result === null) {
        setDockerCheckStatus("error");
        return previous === true;
      }

      let available = result.available;
      const firstFailureReason = available ? null : result.reason;

      const publishResult = (next: DockerAvailability) => {
        dockerAvailableRef.current = next.available;
        setDockerAvailable(next.available);
        setDockerUnavailableReason(next.reason);
      };

      // Keep the established non-blocking startup behavior for daemon and
      // permission diagnostics. A first `not-installed` result is the special
      // updater-sensitive case: confirm it before telling the user a binary
      // that worked in the previous process has disappeared.
      const firstResultWasPublished =
        source === "startup" && (available || result.reason !== "not-installed");
      if (firstResultWasPublished) {
        publishResult(result);
      }

      // A single failed probe is not evidence of an outage. `check_docker`
      // shells out to `docker info` with a 10s timeout and reports any failure
      // - including that timeout - as "unavailable", so a loaded host or a
      // startup race can produce a false negative. Tearing down container-backed
      // UI on one of those is destructive, so confirm transient failures before
      // publishing them. This also includes a first `not-installed` result: an
      // updater relaunch can briefly expose an incomplete host execution
      // environment even though the next launch finds the same binary normally.
      // Durable permission denials and a probe that already consumed its 10s
      // timeout do not benefit from another blocking startup probe.
      for (
        let attempt = 1;
        !available &&
        (previous === true || source === "startup") &&
        result.reason !== "permission-denied" &&
        !(source === "startup" && result.reason === "timed-out") &&
        attempt < DOCKER_UNAVAILABLE_CONFIRMATIONS;
        attempt++
      ) {
        if (source === "startup") await waitForDockerStartupConfirmation();
        const confirmation = await probeDocker(source);
        if (confirmation === null) {
          setDockerCheckStatus("error");
          return previous === true;
        }
        result = confirmation;
        available = result.available;
      }

      // Preserve a diagnostic that the user may already be reading, but never
      // restore the deliberately withheld `not-installed` diagnosis after a
      // confirming probe proves that the Docker binary exists.
      if (!available && firstResultWasPublished && firstFailureReason !== null) {
        result = { available: false, reason: firstFailureReason };
      }

      rendererDebugLog(`[App] Docker ${source} check:`, available);
      publishResult(result);
      setDockerCheckStatus("complete");

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
    if (!macOsPermissionsReady) return;
    const initDocker = async () => {
      await refreshDockerAvailability("startup");
    };

    void initDocker();
  }, [macOsPermissionsReady, refreshDockerAvailability]);

  // Docker can be started or stopped while Orkestrator remains open. Keep the
  // shared capability state fresh in both directions without overlapping a
  // slow daemon probe.
  useEffect(() => {
    if (!macOsPermissionsReady) return;
    const interval = window.setInterval(() => {
      void refreshDockerAvailability("poll");
    }, DOCKER_AVAILABILITY_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [macOsPermissionsReady, refreshDockerAvailability]);

  // Dismissing an outage should last for that outage. Once Docker recovers, a
  // later outage is new information and should warn the user again.
  useEffect(() => {
    if (dockerAvailable === true) setDockerWarningDismissed(false);
  }, [dockerAvailable]);

  // Host CLI availability is independent of Docker. Run it in parallel with
  // the daemon probe so local worktree workflows receive the same onboarding.
  useEffect(() => {
    if (!macOsPermissionsReady) return;
    let active = true;
    const checkHostTools = async () => {
      setHostToolCheckStatus("checking");
      let results = await Promise.allSettled([
        checkClaudeCli(),
        checkClaudeConfig(),
        checkOpencodeCli(),
        checkCodexCli(),
        checkGithubCli(),
        getAvailableAiCli(),
      ]);

      const firstClaudeCli = results[0]?.status === "fulfilled" ? results[0].value : undefined;
      const firstClaudeConfig = results[1]?.status === "fulfilled" ? results[1].value : undefined;
      const firstGithubCli = results[4]?.status === "fulfilled" ? results[4].value : undefined;
      const firstAiCli = results[5]?.status === "fulfilled" ? results[5].value : undefined;
      const needsConfirmation =
        results.some((result) => result.status === "rejected") ||
        !firstAiCli ||
        firstGithubCli === false ||
        (firstClaudeCli === true && firstClaudeConfig === false);
      if (needsConfirmation) {
        await waitForHostToolStartupConfirmation();
        if (!active) return;
        results = await Promise.allSettled([
          checkClaudeCli(),
          checkClaudeConfig(),
          checkOpencodeCli(),
          checkCodexCli(),
          checkGithubCli(),
          getAvailableAiCli(),
        ]);
      }
      if (!active) return;

      const failures = results.flatMap((result, index) =>
        result.status === "rejected" ? [{ index, reason: result.reason }] : [],
      );
      if (failures.length > 0) {
        for (const failure of failures) {
          console.error(`[App] CLI startup check ${failure.index + 1} failed:`, failure.reason);
        }
        // Unknown is not absent. Keep all definitive fulfilled values, but do
        // not show installation onboarding from an incomplete capability set.
        setHostToolCheckStatus("error");
      } else {
        setHostToolCheckStatus("complete");
      }

      const [claudeCli, claudeConfig, opencodeCli, codexCli, githubCli] = results.map((result) =>
        result.status === "fulfilled" ? result.value : null,
      );
      const aiCli = results[5]?.status === "fulfilled" ? results[5].value : undefined;
      if (typeof claudeCli === "boolean") setClaudeCliAvailable(claudeCli);
      if (typeof claudeConfig === "boolean") setClaudeConfigAvailable(claudeConfig);
      if (typeof opencodeCli === "boolean") setOpencodeCliAvailable(opencodeCli);
      if (typeof codexCli === "boolean") setCodexCliAvailable(codexCli);
      if (typeof githubCli === "boolean") setGithubCliAvailable(githubCli);
      if (typeof aiCli === "string" || aiCli === null) setAvailableAiCli(aiCli);

      if (failures.length === 0) {
        rendererDebugLog("[App] Claude CLI available:", claudeCli);
        rendererDebugLog("[App] Claude config available:", claudeConfig);
        rendererDebugLog("[App] OpenCode CLI available:", opencodeCli);
        rendererDebugLog("[App] Codex CLI available:", codexCli);
        rendererDebugLog("[App] GitHub CLI available:", githubCli);
        rendererDebugLog("[App] Available AI CLI:", aiCli);
      }
    };
    void checkHostTools();
    return () => {
      active = false;
    };
  }, [macOsPermissionsReady]);

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
    setDockerCheckStatus("checking");
    try {
      await refreshDockerAvailability("retry");
    } finally {
      setIsCheckingDocker(false);
    }
  };

  const handleOpenMacOsSettings = async (pane: MacOsPrivacySettingsPane) => {
    try {
      await window.orkestrator?.permissions?.openMacOsSettings(pane);
    } catch (error) {
      toast.error("Could not open System Settings", {
        description: error instanceof Error ? error.message : String(error),
      });
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
    setHostToolCheckStatus("checking");
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
      setHostToolCheckStatus("complete");
    } catch (error) {
      console.error("[App] CLI retry check failed:", error);
      // The retry controls live in the current warning. Keep that warning
      // reachable and report the transient failure instead of silently
      // unmounting the user's only recovery path.
      setHostToolCheckStatus("complete");
      toast.error("Could not check CLI tools", {
        description: error instanceof Error ? error.message : String(error),
      });
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
    (dockerCheckStatus === "error" && dockerAvailable === null) ||
    dockerAvailable === true ||
    (dockerAvailable === false && dockerWarningDismissed);

  const isCheckingCliTools = hostToolWarningsVisible && hostToolCheckStatus === "checking";

  const noAiCliAvailable =
    hostToolWarningsVisible &&
    hostToolCheckStatus === "complete" &&
    availableAiCli === null &&
    claudeCliAvailable === false &&
    opencodeCliAvailable === false &&
    codexCliAvailable === false;

  const claudeNeedsLogin =
    hostToolWarningsVisible &&
    hostToolCheckStatus === "complete" &&
    claudeCliAvailable === true &&
    claudeConfigAvailable === false &&
    opencodeCliAvailable === false;

  const showGithubWarning =
    hostToolWarningsVisible &&
    hostToolCheckStatus === "complete" &&
    (claudeCliAvailable === true || opencodeCliAvailable === true) &&
    githubCliAvailable === false &&
    !githubCliWarningDismissed;

  const handleStartEnvironmentFromOverlay = useCallback(
    async (environmentId: string, initialPrompt?: string): Promise<boolean> => {
      if (!macOsPermissionsReady) return false;
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
         * would run a prompt whose attachments are missing.
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
          const prepared = await prepareEnvironmentAgentLaunch(environmentId, {
            agent: launchOptions.agentType,
            initialPrompt: launchPrompt,
            model: launchOptions.model,
            reasoningEffort: launchOptions.reasoningEffort,
            fastMode: launchOptions.fastMode,
            attachments: launchOptions.initialPromptAttachments,
          });
          useEnvironmentStore.getState().updateEnvironment(environmentId, prepared);
        } catch (error) {
          console.error("[App] Failed to persist startup agent launch:", error);
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
        console.error("[App] Failed to start environment from terminal overlay:", error);
        return false;
      }
    },
    [
      clearClaudeOptions,
      config,
      dockerAvailable,
      getEnvironmentById,
      macOsPermissionsReady,
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

  const dockerWarning = dockerUnavailableMessage(dockerUnavailableReason);

  return (
    <TooltipProvider>
      <TerminalProvider>
        <DockerAvailabilityProvider available={dockerAvailable === true}>
          <AppShell>
            {localBackendUnavailableMessage && (
              <div
                role="alert"
                className="fixed inset-x-4 top-4 z-[90] flex items-center justify-between gap-4 rounded-lg border border-red-500/40 bg-red-950/95 px-4 py-3 text-sm text-red-100 shadow-xl"
              >
                <span>{localBackendUnavailableMessage}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void restart().catch((error) => {
                      toast.error("Could not restart Orkestrator", {
                        description: error instanceof Error ? error.message : String(error),
                      });
                    });
                  }}
                >
                  Restart Orkestrator
                </Button>
              </div>
            )}
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
              <ProjectWorkspace projectId={selectedProjectId} />
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

        {macOsPermissionsReady && dockerCheckStatus === "error" && dockerAvailable === null && (
          <div
            role="alert"
            className="fixed inset-x-4 bottom-4 z-[90] flex items-center justify-between gap-4 rounded-lg border border-amber-500/40 bg-amber-950/95 px-4 py-3 text-sm text-amber-100 shadow-xl"
          >
            <span>
              Orkestrator could not check Docker availability. Container actions remain disabled
              until the check succeeds.
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRetryDockerCheck}
              disabled={isCheckingDocker}
            >
              {isCheckingDocker ? "Checking..." : "Check Docker Again"}
            </Button>
          </div>
        )}

        {/* macOS privacy access is resolved before any Docker probe starts. */}
        {showStartupBlocker && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background px-6">
            {!connectionScopeResolved || macOsPermissions === null ? (
              <div className="flex flex-col items-center gap-4 text-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <div>
                  <h1 className="text-lg font-semibold">
                    {!connectionScopeResolved
                      ? "Starting Orkestrator..."
                      : "Checking macOS file access..."}
                  </h1>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {!connectionScopeResolved
                      ? "Resolving the desktop connection before local file-access checks."
                      : "This prevents permission prompts from interrupting agent work later."}
                  </p>
                </div>
                {connectionScopeResolved && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => void refreshMacOsPermissions()}
                  >
                    Check Again
                  </Button>
                )}
              </div>
            ) : macOsProbeFailed ? (
              <div className="w-full max-w-2xl rounded-xl border bg-card p-8 shadow-2xl">
                <div className="mb-6">
                  <p className="mb-2 text-xs font-semibold tracking-widest text-primary uppercase">
                    Setup needed
                  </p>
                  <h1 className="text-2xl font-semibold">Could not check macOS file access</h1>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    {macOsPermissions.error}
                  </p>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    type="button"
                    onClick={() => void refreshMacOsPermissions()}
                    disabled={isCheckingMacOsPermissions}
                  >
                    {isCheckingMacOsPermissions ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Checking...
                      </>
                    ) : (
                      "Check Again"
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      void restart().catch((error) => {
                        toast.error("Could not restart Orkestrator", {
                          description: error instanceof Error ? error.message : String(error),
                        });
                      });
                    }}
                  >
                    Restart App
                  </Button>
                </div>
              </div>
            ) : (
              <div className="w-full max-w-2xl rounded-xl border bg-card p-8 shadow-2xl">
                <div className="mb-6">
                  <p className="mb-2 text-xs font-semibold tracking-widest text-primary uppercase">
                    {macOsHasBlockingMissing ? "Setup required" : "Recommended setup"}
                  </p>
                  <h1 className="text-2xl font-semibold">macOS File Access</h1>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    {macOsHasBlockingMissing
                      ? "Grant the missing folder, Photos, and Media access before continuing so agents can search your home directory without interrupting their work with macOS privacy prompts."
                      : "Full Disk Access is strongly recommended for searches that begin at the filesystem root. You can grant it now or continue and add it later."}
                  </p>
                </div>

                <ul className="mb-6 space-y-2" aria-label="Missing macOS permissions">
                  {macOsPermissions.missing.map((permission) => (
                    <li
                      key={permission.id}
                      className="flex items-center justify-between gap-4 rounded-lg border bg-muted/40 px-4 py-3"
                    >
                      <span className="font-medium">{permission.label}</span>
                      <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
                        {permission.id === "full-disk-access" ? "Recommended" : "Required"}
                      </span>
                    </li>
                  ))}
                </ul>

                <p className="mb-5 text-sm leading-6 text-muted-foreground">
                  In System Settings, enable Orkestrator in the indicated Privacy &amp; Security
                  panes, then return here and check again. Full Disk Access is never granted by a
                  prompt: add Orkestrator manually. macOS may require an app restart before a new
                  Full Disk Access grant takes effect.
                </p>

                <div className="flex flex-wrap justify-end gap-2">
                  {macOsPermissions.missing.some(
                    (permission) => permission.settingsPane === "files-and-folders",
                  ) && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void handleOpenMacOsSettings("files-and-folders")}
                    >
                      Open Files &amp; Folders Settings
                    </Button>
                  )}
                  {macOsPermissions.missing.some(
                    (permission) => permission.settingsPane === "full-disk-access",
                  ) && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void handleOpenMacOsSettings("full-disk-access")}
                    >
                      Open Full Disk Access Settings
                    </Button>
                  )}
                  {macOsPermissions.missing.some(
                    (permission) => permission.settingsPane === "photos",
                  ) && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void handleOpenMacOsSettings("photos")}
                    >
                      Open Photos Settings
                    </Button>
                  )}
                  {macOsPermissions.missing.some(
                    (permission) => permission.settingsPane === "media-library",
                  ) && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void handleOpenMacOsSettings("media-library")}
                    >
                      Open Media Library Settings
                    </Button>
                  )}
                  <Button
                    type="button"
                    onClick={() => void refreshMacOsPermissions()}
                    disabled={isCheckingMacOsPermissions}
                  >
                    {isCheckingMacOsPermissions ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Checking...
                      </>
                    ) : (
                      "Check Again"
                    )}
                  </Button>
                  {!macOsHasBlockingMissing && macOsHasAdvisoryMissing && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setMacOsAdvisoryDismissed(true)}
                    >
                      Continue without Full Disk Access
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      void restart().catch((error) => {
                        toast.error("Could not restart Orkestrator", {
                          description: error instanceof Error ? error.message : String(error),
                        });
                      });
                    }}
                  >
                    Restart App
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Loading overlay while checking Docker */}
        {macOsPermissionsReady && dockerCheckStatus === "checking" && dockerAvailable === null && (
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
              <AlertDialogTitle>{dockerWarning.title}</AlertDialogTitle>
              <AlertDialogDescription>
                {dockerWarning.description}
                <br />
                <br />
                Container functionality is currently disabled. You can continue using local worktree
                environments while Docker is unavailable. Orkestrator will check again automatically
                every 60 seconds. Docker is available from{" "}
                <a
                  href="https://docker.com"
                  className="text-primary underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  docker.com
                </a>
                .
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
