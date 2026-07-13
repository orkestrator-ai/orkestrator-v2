import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  Shield,
  Globe,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Settings2,
  Network,
  Plus,
  Trash2,
  Laptop,
  FolderOpen,
  Puzzle,
  Server,
  Bot,
  Terminal,
} from "lucide-react";
import { ClaudeIcon, CodexIcon, OpenCodeIcon } from "@/components/icons/AgentIcons";
import { cn } from "@/lib/utils";
import { FullscreenSettingsLayout, type SettingsMenuItem } from "@/components/settings/FullscreenSettingsLayout";
import * as backend from "@/lib/backend";
import { useConfigStore } from "@/stores";
import { useClaudeStore } from "@/stores/claudeStore";
import {
  createClient,
  getMcpServers,
  getPlugins,
  getSessionInitData as fetchSessionInitData,
  type McpServerInfo,
  type PluginInfo,
} from "@/lib/claude-client";
import type {
  ClaudeMode,
  ClaudeNativeBackend,
  CodexMode,
  DefaultAgent,
  DomainTestResult,
  Environment,
  OpenCodeMode,
  PortMapping,
  PortProtocol,
} from "@/types";

// Domain validation regex
const DOMAIN_REGEX = /^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

interface EnvironmentSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environment: Environment;
  onUpdate: (environment: Environment) => void;
  onRestart?: (environmentId: string) => Promise<void>;
}

/** Reusable component for displaying runtime-only extension items */
function RuntimeExtensionItem({
  name,
  isSuccess,
  isFailed,
  error,
}: {
  name: string;
  isSuccess: boolean;
  isFailed: boolean;
  error?: string;
}) {
  return (
    <div
      className={`flex items-center justify-between p-2 rounded-md bg-muted/50 border text-sm ${isFailed ? "border-red-300" : "border-input"}`}
      title={isFailed && error ? error : undefined}
    >
      <div className="flex items-center gap-2 min-w-0">
        {isSuccess ? (
          <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
        ) : (
          <XCircle className="h-3 w-3 text-red-500 shrink-0" />
        )}
        <span className={`font-medium truncate ${isFailed ? "text-red-600" : ""}`}>{name}</span>
      </div>
      <span className="text-xs text-muted-foreground shrink-0 ml-2">runtime</span>
    </div>
  );
}

export function EnvironmentSettingsDialog({
  open,
  onOpenChange,
  environment,
  onUpdate,
  onRestart,
}: EnvironmentSettingsDialogProps) {
  const { config } = useConfigStore();
  const globalDomains = config.global.allowedDomains || [];

  // Name state
  const [name, setName] = useState(environment.name);
  const [nameError, setNameError] = useState<string | null>(null);

  // Network state
  const [useGlobalDefaults, setUseGlobalDefaults] = useState(
    !environment.allowedDomains || environment.allowedDomains.length === 0
  );
  const [customDomains, setCustomDomains] = useState(
    (environment.allowedDomains || globalDomains).join("\n")
  );
  const [domainErrors, setDomainErrors] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResults, setTestResults] = useState<DomainTestResult[] | null>(null);

  // Port mapping state
  const [portMappings, setPortMappings] = useState<PortMapping[]>(
    environment.portMappings || []
  );
  const [showAddPortForm, setShowAddPortForm] = useState(false);
  const [newPortMapping, setNewPortMapping] = useState<PortMapping>({
    containerPort: 3000,
    hostPort: 3000,
    protocol: "tcp",
  });
  const [portError, setPortError] = useState<string | null>(null);
  const [showRestartConfirm, setShowRestartConfirm] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);

  // Agent settings state
  const [envDefaultAgent, setEnvDefaultAgent] = useState<string>(
    environment.defaultAgent ?? "global"
  );
  const [envClaudeMode, setEnvClaudeMode] = useState<string>(
    environment.claudeMode ?? "global"
  );
  // "default" = inherit from repo, then global. "sdk" / "tmux" = override.
  const [envClaudeNativeBackend, setEnvClaudeNativeBackend] = useState<string>(
    environment.claudeNativeBackend ?? "default"
  );
  const [envOpencodeMode, setEnvOpencodeMode] = useState<string>(
    environment.opencodeMode ?? "global"
  );
  const [envCodexMode, setEnvCodexMode] = useState<string>(
    environment.codexMode ?? "global"
  );

  // MCP servers and plugins state
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
  const [pluginsList, setPluginsList] = useState<PluginInfo[]>([]);
  const [isLoadingExtensions, setIsLoadingExtensions] = useState(false);

  // Get Claude session init data for runtime status
  const sessionInitData = useClaudeStore((state) => state.getSessionInitData(environment.id));

  // Track if port mappings have changed
  const portMappingsChanged = JSON.stringify(portMappings) !== JSON.stringify(environment.portMappings || []);

  const agentSettingsChanged =
    (envDefaultAgent === "global" ? undefined : envDefaultAgent) !== (environment.defaultAgent ?? undefined) ||
    (envClaudeMode === "global" ? undefined : envClaudeMode) !== (environment.claudeMode ?? undefined) ||
    (envClaudeNativeBackend === "default" ? undefined : envClaudeNativeBackend) !== (environment.claudeNativeBackend ?? undefined) ||
    (envOpencodeMode === "global" ? undefined : envOpencodeMode) !== (environment.opencodeMode ?? undefined) ||
    (envCodexMode === "global" ? undefined : envCodexMode) !== (environment.codexMode ?? undefined);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      // Reset name
      setName(environment.name);
      setNameError(null);

      // Reset network settings
      const customDomainList = environment.allowedDomains ?? [];
      const hasCustom = customDomainList.length > 0;
      setUseGlobalDefaults(!hasCustom);
      setCustomDomains(
        (hasCustom ? customDomainList : globalDomains).join("\n")
      );
      setDomainErrors([]);
      setTestResults(null);

      // Reset port state
      setPortMappings(environment.portMappings || []);
      setShowAddPortForm(false);
      setNewPortMapping({ containerPort: 3000, hostPort: 3000, protocol: "tcp" });
      setPortError(null);
      setShowRestartConfirm(false);
      setIsRestarting(false);

      // Reset agent settings
      setEnvDefaultAgent(environment.defaultAgent ?? "global");
      setEnvClaudeMode(environment.claudeMode ?? "global");
      setEnvClaudeNativeBackend(environment.claudeNativeBackend ?? "default");
      setEnvOpencodeMode(environment.opencodeMode ?? "global");
      setEnvCodexMode(environment.codexMode ?? "global");
    }
  }, [open, environment.name, environment.allowedDomains, environment.portMappings, environment.defaultAgent, environment.claudeMode, environment.opencodeMode, environment.codexMode, globalDomains]);

  // Update custom domains when toggling to global
  useEffect(() => {
    if (useGlobalDefaults) {
      setCustomDomains(globalDomains.join("\n"));
      setDomainErrors([]);
      setTestResults(null);
    }
  }, [useGlobalDefaults, globalDomains]);

  // Clear extensions data when dialog closes to prevent stale data flash
  useEffect(() => {
    if (!open) {
      setMcpServers([]);
      setPluginsList([]);
    }
  }, [open]);

  // Fetch MCP servers and plugins when dialog opens
  // Note: We use getState() to get a one-time snapshot when the dialog opens,
  // rather than subscribing to changes. This is intentional - we only need
  // the server status at fetch time, not reactive updates during the fetch.
  useEffect(() => {
    if (!open) return;

    // Only fetch for local environments with Claude native mode
    const claudeServerStatus = useClaudeStore.getState().getServerStatus(environment.id);
    if (!claudeServerStatus?.running || !claudeServerStatus.hostPort) return;

    const fetchExtensions = async () => {
      setIsLoadingExtensions(true);
      try {
        const client = createClient(`http://localhost:${claudeServerStatus.hostPort}`);
        const [mcpResult, pluginsResult] = await Promise.all([
          getMcpServers(client),
          getPlugins(client),
        ]);
        setMcpServers(mcpResult.servers);
        setPluginsList(pluginsResult.plugins);

        // If sessionInitData is not available in the store, try to fetch it via API
        // This handles race conditions where the session.init SSE event was missed
        const currentSessionInitData = useClaudeStore.getState().getSessionInitData(environment.id);
        if (!currentSessionInitData) {
          // Find the session ID for this environment by looking through stored sessions
          const sessions = useClaudeStore.getState().sessions;
          const envPrefix = `env-${environment.id}:`;
          let sessionId: string | null = null;

          for (const [sessionKey, sessionState] of sessions) {
            if (sessionKey.startsWith(envPrefix) && sessionState.sessionId) {
              sessionId = sessionState.sessionId;
              break;
            }
          }

          if (sessionId) {
            try {
              const initData = await fetchSessionInitData(client, sessionId);
              if (initData) {
                // Store in the zustand store so it's available for subsequent renders
                useClaudeStore.getState().setSessionInitData(environment.id, initData);
              }
            } catch (fetchErr) {
              console.debug("[EnvironmentSettingsDialog] Failed to fetch session init data:", fetchErr);
            }
          }
        }
      } catch (err) {
        console.error("[EnvironmentSettingsDialog] Failed to fetch extensions:", err);
      } finally {
        setIsLoadingExtensions(false);
      }
    };

    fetchExtensions();
  }, [open, environment.id]);

  // Validate name
  const validateName = (value: string): boolean => {
    const trimmed = value.trim();
    if (!trimmed) {
      setNameError("Name cannot be empty");
      return false;
    }
    if (trimmed.length > 100) {
      setNameError("Name cannot exceed 100 characters");
      return false;
    }
    setNameError(null);
    return true;
  };

  // Handle name change
  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setName(value);
    validateName(value);
  };

  // Validate domains locally
  const validateDomainsLocally = useCallback((domainsText: string) => {
    const domains = domainsText
      .split("\n")
      .map((d) => d.trim())
      .filter((d) => d.length > 0);

    const errors: string[] = [];
    for (const domain of domains) {
      if (!DOMAIN_REGEX.test(domain)) {
        errors.push(`Invalid domain format: ${domain}`);
      }
    }
    setDomainErrors(errors);
    setTestResults(null);
    return errors.length === 0;
  }, []);

  // Handle domain textarea change
  const handleDomainsChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setCustomDomains(value);
    validateDomainsLocally(value);
  };

  // Test DNS resolution
  const handleTestDomains = async () => {
    const domains = customDomains
      .split("\n")
      .map((d) => d.trim())
      .filter((d) => d.length > 0);

    if (domains.length === 0) return;

    setIsTesting(true);
    setTestResults(null);
    try {
      const results = await backend.testDomainResolution(domains);
      setTestResults(results);
    } catch (err) {
      console.error("[EnvironmentSettingsDialog] Failed to test domains:", err);
    } finally {
      setIsTesting(false);
    }
  };

  // Add a port mapping (locally, will be saved on save)
  const handleAddPortMapping = () => {
    // Validate port numbers
    if (newPortMapping.containerPort < 1 || newPortMapping.containerPort > 65535) {
      setPortError("Container port must be between 1 and 65535");
      return;
    }
    if (newPortMapping.hostPort < 1 || newPortMapping.hostPort > 65535) {
      setPortError("Host port must be between 1 and 65535");
      return;
    }

    // Check for duplicate container port
    if (portMappings.some(m => m.containerPort === newPortMapping.containerPort && m.protocol === newPortMapping.protocol)) {
      setPortError(`Port ${newPortMapping.containerPort}/${newPortMapping.protocol} is already mapped`);
      return;
    }

    setPortError(null);
    setPortMappings([...portMappings, { ...newPortMapping }]);
    setShowAddPortForm(false);
    setNewPortMapping({ containerPort: 3000, hostPort: 3000, protocol: "tcp" });
  };

  // Remove a port mapping (locally, will be saved on save)
  const handleRemovePortMapping = (index: number) => {
    setPortMappings(portMappings.filter((_, i) => i !== index));
    setPortError(null);
  };

  // Handle restart with port changes
  const handleRestartWithChanges = async () => {
    if (!onRestart) return;

    setIsRestarting(true);
    try {
      // First save the port mappings
      await backend.updatePortMappings(environment.id, portMappings);

      // Optimistically update status to "creating" so the UI shows a spinner immediately
      onUpdate({ ...environment, status: "creating" });

      // Close the dialog immediately so user can see the spinner in the sidebar
      setShowRestartConfirm(false);
      onOpenChange(false);

      // Then recreate the environment (this creates a new container with new port mappings)
      await onRestart(environment.id);

      // Sync the environment to get the updated container_id and status
      const synced = await backend.syncEnvironmentStatus(environment.id);
      onUpdate(synced);

      toast.success("Environment recreated with new port mappings");
    } catch (err) {
      console.error("[EnvironmentSettingsDialog] Failed to restart with changes:", err);
      const message = err instanceof Error ? err.message : String(err);
      toast.error("Failed to recreate environment", { description: message });

      // Try to sync even on error to get the correct state
      try {
        const synced = await backend.syncEnvironmentStatus(environment.id);
        onUpdate(synced);
      } catch {
        // Ignore sync errors
      }
    } finally {
      setIsRestarting(false);
    }
  };

  // Save changes
  const handleSave = async () => {
    // Validate name
    if (!validateName(name)) {
      return;
    }

    // If port mappings changed and environment is running, show restart confirmation
    if (portMappingsChanged && environment.status === "running" && onRestart) {
      setShowRestartConfirm(true);
      return;
    }

    const domains = useGlobalDefaults
      ? undefined
      : customDomains
          .split("\n")
          .map((d) => d.trim())
          .filter((d) => d.length > 0);

    setIsSaving(true);
    try {
      let updated = environment;

      // Update name if changed
      const trimmedName = name.trim();
      if (trimmedName !== environment.name) {
        updated = await backend.renameEnvironment(environment.id, trimmedName);
      }

      // Update domains if not in full access mode
      const isFullAccess = (environment.networkAccessMode ?? "restricted") === "full";
      if (!isFullAccess) {
        const domainsToSave = useGlobalDefaults ? [] : (domains || []);
        updated = await backend.updateEnvironmentAllowedDomains(
          environment.id,
          domainsToSave
        );
      }

      // Update port mappings if changed (only effective after restart for running containers)
      if (portMappingsChanged) {
        updated = await backend.updatePortMappings(environment.id, portMappings);
      }

      // Update agent settings if changed
      if (agentSettingsChanged) {
        updated = await backend.updateEnvironmentAgentSettings(
          environment.id,
          envDefaultAgent === "global" ? null : envDefaultAgent as DefaultAgent,
          envClaudeMode === "global" ? null : envClaudeMode as ClaudeMode,
          envClaudeNativeBackend === "default" ? null : envClaudeNativeBackend as ClaudeNativeBackend,
          envOpencodeMode === "global" ? null : envOpencodeMode as OpenCodeMode,
          envCodexMode === "global" ? null : envCodexMode as CodexMode,
        );
      }

      onUpdate(updated);
      toast.success("Environment settings saved");
      onOpenChange(false);
    } catch (err) {
      console.error("[EnvironmentSettingsDialog] Failed to save:", err);
      const message = err instanceof Error ? err.message : "Failed to save settings";
      setNameError(message);
      toast.error("Failed to save settings", { description: message });
    } finally {
      setIsSaving(false);
    }
  };

  const isFullAccess = (environment.networkAccessMode ?? "restricted") === "full";
  const isLocalEnvironment = environment.environmentType === "local";
  const isClaudeNativeMode = isLocalEnvironment && config.global.claudeMode === "native";
  const hasErrors = nameError !== null || domainErrors.length > 0;

  // Determine if we should show the extensions section
  const hasExtensionsToShow =
    isClaudeNativeMode ||
    mcpServers.length > 0 ||
    pluginsList.length > 0 ||
    (sessionInitData?.mcpServers?.length ?? 0) > 0 ||
    (sessionInitData?.plugins?.length ?? 0) > 0 ||
    isLoadingExtensions;

  const menuItems: SettingsMenuItem[] = [
    { id: "general", label: "General", icon: <Settings2 className="h-4 w-4" /> },
    { id: "agent", label: "Agent", icon: <Bot className="h-4 w-4" /> },
    ...(!isLocalEnvironment ? [
      { id: "network", label: "Network", icon: <Shield className="h-4 w-4" /> },
      { id: "ports", label: "Ports", icon: <Network className="h-4 w-4" /> },
    ] : []),
    ...(hasExtensionsToShow ? [
      { id: "extensions", label: "Extensions", icon: <Puzzle className="h-4 w-4" /> },
    ] : []),
  ];

  const renderSection = (section: string) => {
    switch (section) {
      case "general":
        return (
          <div className="max-w-2xl space-y-6">
            <div className="space-y-2">
              <Label htmlFor="env-name">Name</Label>
              <Input id="env-name" value={name} onChange={handleNameChange} placeholder="Environment name" />
              {nameError && <p className="text-sm text-destructive">{nameError}</p>}
            </div>
            {isLocalEnvironment && (
              <div className="space-y-4">
                <Label>Environment Type</Label>
                <div className="flex items-center gap-2 p-3 rounded-md bg-zinc-900">
                  <Laptop className="h-4 w-4 text-blue-500 shrink-0" />
                  <div>
                    <div className="font-medium text-sm">Local Environment</div>
                    <div className="text-xs text-muted-foreground">Uses a git worktree on your machine (no Docker container)</div>
                  </div>
                </div>
                {environment.worktreePath && (
                  <div className="space-y-2">
                    <Label>Worktree Location</Label>
                    <div className="flex items-center gap-2 p-2 rounded-md bg-zinc-900">
                      <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="text-sm font-mono truncate">{environment.worktreePath}</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      case "agent":
        return (
          <div className="max-w-2xl space-y-8">
            <p className="text-xs text-muted-foreground">Override global defaults for this environment. "Use global default" inherits from app settings.</p>

            {/* Default Agent */}
            <div className="space-y-3">
              <Label className="text-sm">Default Agent</Label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {([
                  { value: "global", label: `Global (${config.global.defaultAgent === "claude" ? "Claude" : config.global.defaultAgent === "codex" ? "Codex" : "OpenCode"})`, icon: <Bot className="h-4 w-4" /> },
                  { value: "claude", label: "Claude", icon: <ClaudeIcon className="h-4 w-4" /> },
                  { value: "opencode", label: "OpenCode", icon: <OpenCodeIcon className="h-4 w-4" /> },
                  { value: "codex", label: "Codex", icon: <CodexIcon className="h-4 w-4 text-emerald-400" /> },
                ] as const).map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setEnvDefaultAgent(opt.value)}
                    className={cn(
                      "p-3 rounded-lg border-2 text-left transition-colors",
                      envDefaultAgent === opt.value
                        ? "border-primary bg-primary/5"
                        : "border-transparent bg-zinc-900 hover:border-zinc-600"
                    )}
                  >
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {opt.icon}
                      {opt.label}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Claude Mode */}
            <div className="space-y-3">
              <Label className="text-sm">Claude Mode</Label>
              <div className="grid max-w-md grid-cols-1 gap-2 sm:grid-cols-3">
                {([
                  { value: "global", label: `Global (${config.global.claudeMode === "native" ? "Native" : "Terminal"})`, icon: <Bot className="h-3.5 w-3.5" /> },
                  { value: "terminal", label: "Terminal", icon: <Terminal className="h-3.5 w-3.5" /> },
                  { value: "native", label: "Native", icon: <Bot className="h-3.5 w-3.5" /> },
                ] as const).map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setEnvClaudeMode(opt.value)}
                    className={cn(
                      "p-2 rounded-lg border-2 text-left transition-colors",
                      envClaudeMode === opt.value
                        ? "border-primary bg-primary/5"
                        : "border-transparent bg-zinc-900 hover:border-zinc-600"
                    )}
                  >
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {opt.icon}
                      {opt.label}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Claude Native backend (only meaningful when resolved mode is Native) */}
            <div className="space-y-3">
              <Label className="text-sm">Claude Native backend</Label>
              <div className="grid max-w-md grid-cols-1 gap-2 sm:grid-cols-3">
                {([
                  {
                    value: "default",
                    label: `Default (${
                      (
                        config.repositories[environment.projectId]?.claudeNativeBackend ??
                        config.global.claudeNativeBackend ??
                        "sdk"
                      ) === "tmux"
                        ? "Tmux"
                        : "Agent SDK"
                    })`,
                  },
                  { value: "sdk", label: "Agent SDK" },
                  { value: "tmux", label: "Tmux" },
                ] as const).map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setEnvClaudeNativeBackend(opt.value)}
                    className={cn(
                      "p-2 rounded-lg border-2 text-left text-sm font-medium transition-colors",
                      envClaudeNativeBackend === opt.value
                        ? "border-primary bg-primary/5"
                        : "border-transparent bg-zinc-900 hover:border-zinc-600",
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Only applies when Claude Mode is Native. Default inherits from
                the repository setting, then the app default.
              </p>
            </div>

            {/* OpenCode Mode */}
            <div className="space-y-3">
              <Label className="text-sm">OpenCode Mode</Label>
              <div className="grid max-w-md grid-cols-1 gap-2 sm:grid-cols-3">
                {([
                  { value: "global", label: `Global (${(config.global.opencodeMode || "terminal") === "native" ? "Native" : "Terminal"})`, icon: <Bot className="h-3.5 w-3.5" /> },
                  { value: "terminal", label: "Terminal", icon: <Terminal className="h-3.5 w-3.5" /> },
                  { value: "native", label: "Native", icon: <Bot className="h-3.5 w-3.5" /> },
                ] as const).map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setEnvOpencodeMode(opt.value)}
                    className={cn(
                      "p-2 rounded-lg border-2 text-left transition-colors",
                      envOpencodeMode === opt.value
                        ? "border-primary bg-primary/5"
                        : "border-transparent bg-zinc-900 hover:border-zinc-600"
                    )}
                  >
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {opt.icon}
                      {opt.label}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Codex Mode */}
            <div className="space-y-3">
              <Label className="text-sm">Codex Mode</Label>
              <div className="grid max-w-md grid-cols-1 gap-2 sm:grid-cols-3">
                {([
                  { value: "global", label: `Global (${(config.global.codexMode || "native") === "native" ? "Native" : "Terminal"})`, icon: <Bot className="h-3.5 w-3.5" /> },
                  { value: "terminal", label: "Terminal", icon: <Terminal className="h-3.5 w-3.5" /> },
                  { value: "native", label: "Native", icon: <Bot className="h-3.5 w-3.5" /> },
                ] as const).map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setEnvCodexMode(opt.value)}
                    className={cn(
                      "p-2 rounded-lg border-2 text-left transition-colors",
                      envCodexMode === opt.value
                        ? "border-primary bg-primary/5"
                        : "border-transparent bg-zinc-900 hover:border-zinc-600"
                    )}
                  >
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {opt.icon}
                      {opt.label}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        );
      case "network":
        return (
          <div className="max-w-2xl space-y-4">
            <div className="flex items-center gap-2 p-3 rounded-md bg-zinc-800 border border-zinc-700">
              {isFullAccess ? (
                <><Globe className="h-4 w-4 text-blue-500 shrink-0" /><div><div className="font-medium text-sm">Full Network Access</div><div className="text-xs text-muted-foreground">Unrestricted internet access. Whitelist does not apply.</div></div></>
              ) : (
                <><Shield className="h-4 w-4 text-green-500 shrink-0" /><div><div className="font-medium text-sm">Restricted Network Access</div><div className="text-xs text-muted-foreground">Only whitelisted domains are accessible.</div></div></>
              )}
            </div>
            {!isFullAccess && (
              <>
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5"><Label>Use Global Defaults</Label><p className="text-xs text-muted-foreground">Use default allowed domains</p></div>
                  <Switch checked={useGlobalDefaults} onCheckedChange={setUseGlobalDefaults} />
                </div>
                <div className="space-y-2">
                  <Label>Allowed Domains</Label>
                  <Textarea value={customDomains} onChange={handleDomainsChange} disabled={useGlobalDefaults} placeholder={"github.com\nregistry.npmjs.org\napi.anthropic.com"} rows={8} className={`font-mono text-sm ${domainErrors.length > 0 ? "border-red-500" : ""} ${useGlobalDefaults ? "opacity-50" : ""}`} />
                </div>
                {domainErrors.length > 0 && (
                  <div className="text-sm text-red-500 space-y-1">{domainErrors.map((error, i) => (<div key={i} className="flex items-center gap-1"><XCircle className="h-3 w-3" />{error}</div>))}</div>
                )}
                <Button type="button" variant="outline" size="sm" onClick={handleTestDomains} disabled={isTesting || domainErrors.length > 0 || useGlobalDefaults}>
                  {isTesting ? (<><Loader2 className="mr-2 h-3 w-3 animate-spin" />Testing...</>) : "Test DNS Resolution"}
                </Button>
                {testResults && (
                  <div className="border border-zinc-700 rounded-md p-3 space-y-2 text-sm max-h-32 overflow-y-auto">
                    <div className="font-medium">DNS Test Results:</div>
                    {testResults.map((result, i) => (
                      <div key={i} className="flex items-start gap-2">
                        {result.resolvable ? <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 shrink-0" /> : result.valid ? <AlertCircle className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" /> : <XCircle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />}
                        <div className="min-w-0"><span className="font-mono text-xs break-all">{result.domain}</span>{result.error && <span className="text-red-500 text-xs block">{result.error}</span>}</div>
                      </div>
                    ))}
                  </div>
                )}
                {environment.status === "running" && <p className="text-xs text-muted-foreground">Changes will be applied to the running container immediately.</p>}
              </>
            )}
          </div>
        );
      case "ports":
        return (
          <div className="max-w-2xl space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">Expose container ports to the host machine. Changes require a container restart.</p>
              {!showAddPortForm && <Button type="button" variant="outline" size="sm" onClick={() => setShowAddPortForm(true)}><Plus className="h-4 w-4 mr-1" />Add Port</Button>}
            </div>
            {portMappings.length > 0 && (
              <div className="space-y-2">{portMappings.map((mapping, index) => (
                <div key={`port-${index}`} className="flex items-center justify-between p-2 rounded-md bg-zinc-800/50 border border-zinc-700">
                  <span className="text-sm font-mono">{mapping.containerPort}:{mapping.hostPort}/{mapping.protocol}</span>
                  <Button type="button" variant="ghost" size="icon" onClick={() => handleRemovePortMapping(index)} className="h-7 w-7"><Trash2 className="h-4 w-4" /></Button>
                </div>
              ))}</div>
            )}
            {portError && <div className="flex items-center gap-2 p-2 rounded-md bg-destructive/10 text-destructive text-sm"><XCircle className="h-4 w-4 shrink-0" /><span>{portError}</span></div>}
            {portMappings.length === 0 && !showAddPortForm && <p className="text-sm text-muted-foreground">No port mappings configured. Click "Add Port" to expose a container port.</p>}
            {portMappingsChanged && environment.status === "running" && (
              <div className="flex items-center gap-2 p-2 rounded-md bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 text-sm"><AlertCircle className="h-4 w-4 shrink-0" /><span>Port changes require a container restart to take effect.</span></div>
            )}
            {showAddPortForm && (
              <div className="space-y-3 p-3 rounded-md border border-zinc-700">
                <p className="text-sm font-medium">Add Port Mapping</p>
                <div className="space-y-2">
                  <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                    <Input type="number" placeholder="Container" value={newPortMapping.containerPort} onChange={(e) => setNewPortMapping({ ...newPortMapping, containerPort: parseInt(e.target.value) || 0 })} className="text-sm" min={1} max={65535} />
                    <span className="text-muted-foreground">:</span>
                    <Input type="number" placeholder="Host" value={newPortMapping.hostPort} onChange={(e) => setNewPortMapping({ ...newPortMapping, hostPort: parseInt(e.target.value) || 0 })} className="text-sm" min={1} max={65535} />
                  </div>
                  <Select value={newPortMapping.protocol} onValueChange={(value: PortProtocol) => setNewPortMapping({ ...newPortMapping, protocol: value })}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="tcp">TCP</SelectItem><SelectItem value="udp">UDP</SelectItem></SelectContent>
                  </Select>
                </div>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setShowAddPortForm(false)}>Cancel</Button>
                  <Button type="button" size="sm" onClick={handleAddPortMapping} disabled={newPortMapping.containerPort < 1 || newPortMapping.hostPort < 1}>Add</Button>
                </div>
              </div>
            )}
          </div>
        );
      case "extensions":
        return (
          <div className="max-w-2xl space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6">
              <div className="space-y-2">
                <div className="flex items-center gap-2"><Server className="h-4 w-4 text-muted-foreground" /><Label>MCP Servers</Label></div>
                {isLoadingExtensions ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />Loading...</div>
                ) : mcpServers.length === 0 && !sessionInitData?.mcpServers.length ? (
                  <p className="text-sm text-muted-foreground">No MCP servers configured</p>
                ) : mcpServers.length > 0 ? (
                  <div className="space-y-1 space-y-1">
                    {mcpServers.map((server) => {
                      const runtimeStatus = sessionInitData?.mcpServers.find((s) => s.name === server.name);
                      const isConnected = runtimeStatus?.status === "connected";
                      const hasFailed = runtimeStatus?.status === "failed";
                      return (
                        <div key={server.name} className={`flex items-center justify-between p-2 rounded-md bg-zinc-800/50 border text-sm ${hasFailed ? "border-red-300" : "border-zinc-700"}`} title={hasFailed && runtimeStatus?.error ? runtimeStatus.error : undefined}>
                          <div className="flex items-center gap-2 min-w-0">
                            {runtimeStatus && (isConnected ? <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" /> : hasFailed ? <XCircle className="h-3 w-3 text-red-500 shrink-0" /> : null)}
                            <span className={`font-medium truncate ${hasFailed ? "text-red-600" : ""}`}>{server.name}</span>
                          </div>
                          <span className="text-xs text-muted-foreground shrink-0 ml-2">{server.source === "project" ? "project" : "global"}</span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="space-y-1 space-y-1">{sessionInitData?.mcpServers.map((server) => (<RuntimeExtensionItem key={server.name} name={server.name} isSuccess={server.status === "connected"} isFailed={server.status === "failed"} error={server.error} />))}</div>
                )}
                <p className="text-xs text-muted-foreground">Configure in <code className="text-xs bg-zinc-800 px-1 rounded">.mcp.json</code> or <code className="text-xs bg-zinc-800 px-1 rounded">~/.claude.json</code></p>
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2"><Puzzle className="h-4 w-4 text-muted-foreground" /><Label>Plugins</Label></div>
                {isLoadingExtensions ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />Loading...</div>
                ) : pluginsList.length === 0 && !sessionInitData?.plugins.length ? (
                  <p className="text-sm text-muted-foreground">No plugins configured</p>
                ) : pluginsList.length > 0 ? (
                  <div className="space-y-1 space-y-1">
                    {pluginsList.map((plugin) => {
                      const runtimeStatus = sessionInitData?.plugins.find((p) => p.name === plugin.name);
                      const isLoaded = runtimeStatus?.status === "loaded";
                      const hasFailed = runtimeStatus?.status === "failed";
                      return (
                        <div key={plugin.path} className={`flex items-center justify-between p-2 rounded-md bg-zinc-800/50 border text-sm ${hasFailed ? "border-red-300" : "border-zinc-700"}`} title={hasFailed && runtimeStatus?.error ? runtimeStatus.error : undefined}>
                          <div className="flex items-center gap-2 min-w-0">
                            {runtimeStatus && (isLoaded ? <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" /> : hasFailed ? <XCircle className="h-3 w-3 text-red-500 shrink-0" /> : null)}
                            <span className={`font-medium truncate ${hasFailed ? "text-red-600" : ""}`}>{plugin.name}</span>
                          </div>
                          <span className="text-xs text-muted-foreground shrink-0 ml-2">{plugin.source}</span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="space-y-1 space-y-1">{sessionInitData?.plugins.map((plugin) => (<RuntimeExtensionItem key={plugin.name} name={plugin.name} isSuccess={plugin.status === "loaded"} isFailed={plugin.status === "failed"} error={plugin.error} />))}</div>
                )}
                <p className="text-xs text-muted-foreground">Configure in <code className="text-xs bg-zinc-800 px-1 rounded">.claude/plugins.json</code> or <code className="text-xs bg-zinc-800 px-1 rounded">~/.claude.json</code></p>
              </div>
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <>
    <FullscreenSettingsLayout
      open={open}
      onOpenChange={onOpenChange}
      title="Environment Settings"
      menuItems={menuItems}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={isSaving || hasErrors}>
            {isSaving ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving...</>) : "Save Changes"}
          </Button>
        </>
      }
    >
      {renderSection}
    </FullscreenSettingsLayout>

      {/* Restart confirmation dialog */}
      <AlertDialog open={showRestartConfirm} onOpenChange={setShowRestartConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Container Recreate Required</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>
                Port mapping changes require the container to be recreated.
                <strong> All running processes will be terminated.</strong>
              </p>
              <p className="text-sm">
                Your filesystem state (installed packages, file changes) will be preserved.
                However, any dev servers, build processes, or other running programs will need to be restarted.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRestarting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRestartWithChanges}
              disabled={isRestarting}
            >
              {isRestarting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Restarting...
                </>
              ) : (
                "Restart Environment"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
