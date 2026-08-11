import { useState, useEffect, useCallback, useRef } from "react";
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
  RefreshCw,
} from "lucide-react";
import { ClaudeIcon, CodexIcon, OpenCodeIcon } from "@/components/icons/AgentIcons";
import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";
import { cn } from "@/lib/utils";
import { FullscreenSettingsLayout, type SettingsMenuItem } from "@/components/settings/FullscreenSettingsLayout";
import * as backend from "@/lib/backend";
import { useConfigStore } from "@/stores";
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

const AGENT_ORDER: backend.AgentExtensionId[] = [
  "claude",
  "codex",
  "opencode",
];

const AGENT_EXTENSION_COPY: Record<
  backend.AgentExtensionId,
  {
    label: string;
    mcpConfig: string;
    pluginConfig: string;
  }
> = {
  claude: {
    label: "Claude",
    mcpConfig: ".mcp.json or ~/.claude.json",
    pluginConfig: ".claude/plugins.json or ~/.claude/plugins",
  },
  codex: {
    label: "Codex",
    mcpConfig: "~/.codex/config.toml",
    pluginConfig: "~/.codex/config.toml",
  },
  opencode: {
    label: "OpenCode",
    mcpConfig: "opencode.json(c) or ~/.config/opencode/opencode.json(c)",
    pluginConfig: "opencode.json(c) or ~/.config/opencode/opencode.json(c)",
  },
};

function AgentExtensionIcon({
  agent,
  className,
}: {
  agent: backend.AgentExtensionId;
  className?: string;
}) {
  if (agent === "claude") return <ClaudeIcon className={className} />;
  if (agent === "codex") return <CodexIcon className={cn("text-emerald-400", className)} />;
  return <OpenCodeIcon className={className} />;
}

function ExtensionStatusIcon({
  status,
}: {
  status: backend.AgentExtensionItem["status"];
}) {
  if (status === "connected") {
    return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />;
  }
  if (status === "failed") {
    return <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />;
  }
  if (status === "pending") {
    return <AlertCircle className="h-3.5 w-3.5 shrink-0 text-amber-500" />;
  }
  return (
    <span
      className={cn(
        "h-2 w-2 shrink-0 rounded-full",
        status === "disabled" ? "bg-muted-foreground/50" : "bg-sky-500",
      )}
    />
  );
}

function ExtensionCollection({
  title,
  emptyLabel,
  icon,
  items,
  error,
  configHint,
}: {
  title: string;
  emptyLabel: string;
  icon: React.ReactNode;
  items: backend.AgentExtensionItem[];
  error?: string;
  configHint: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        {icon}
        <h4 className="text-sm font-medium">{title}</h4>
        <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
          {items.length}
        </span>
      </div>
      {error ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : items.length === 0 ? (
        <p className="py-1 text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <div className="space-y-1.5">
          {items.map((item, index) => (
            // Two marketplaces can publish the same plugin name, so the name
            // alone is not a stable key.
            <div
              key={`${item.name}:${item.source ?? item.status}:${index}`}
              className="flex min-w-0 items-center gap-2 rounded-md border border-border/70 bg-muted/30 px-2.5 py-2 text-sm"
            >
              <ExtensionStatusIcon status={item.status} />
              <span className="min-w-0 flex-1 truncate font-medium">
                {item.name}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {item.source ?? item.status}
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="mt-auto text-[11px] leading-relaxed text-muted-foreground">
        Configure in{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
          {configHint}
        </code>
      </p>
    </div>
  );
}

function AgentExtensionSection({
  catalog,
}: {
  catalog: backend.AgentExtensionCatalog;
}) {
  const copy = AGENT_EXTENSION_COPY[catalog.agent];
  const extensionCount = catalog.mcpServers.length + catalog.plugins.length;
  return (
    <section className="overflow-hidden rounded-xl border border-border/80 bg-card/40">
      <div className="flex items-center gap-3 border-b border-border/70 bg-muted/20 px-4 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/70 bg-background">
          <AgentExtensionIcon agent={catalog.agent} className="h-4.5 w-4.5" />
        </div>
        <div>
          <h3 className="text-sm font-semibold">{copy.label}</h3>
          <p className="text-xs text-muted-foreground">
            {extensionCount === 0
              ? "No configured extensions found"
              : `${extensionCount} configured extension${extensionCount === 1 ? "" : "s"}`}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-1 divide-y divide-border/70 md:grid-cols-2 md:divide-x md:divide-y-0">
        <ExtensionCollection
          title="MCP servers"
          emptyLabel="No MCP servers configured"
          icon={<Server className="h-4 w-4 text-muted-foreground" />}
          items={catalog.mcpServers}
          error={catalog.mcpError}
          configHint={copy.mcpConfig}
        />
        <ExtensionCollection
          title="Plugins"
          emptyLabel="No plugins configured"
          icon={<Puzzle className="h-4 w-4 text-muted-foreground" />}
          items={catalog.plugins}
          error={catalog.pluginError}
          configHint={copy.pluginConfig}
        />
      </div>
    </section>
  );
}

function emptyExtensionCatalogs(): backend.AgentExtensionCatalog[] {
  return AGENT_ORDER.map((agent) => ({
    agent,
    mcpServers: [],
    plugins: [],
  }));
}

function orderExtensionCatalogs(
  catalogs: backend.AgentExtensionCatalog[],
): backend.AgentExtensionCatalog[] {
  const byAgent = new Map(catalogs.map((catalog) => [catalog.agent, catalog]));
  return AGENT_ORDER.map(
    (agent) =>
      byAgent.get(agent) ?? {
        agent,
        mcpServers: [],
        plugins: [],
        mcpError: `Could not read ${AGENT_EXTENSION_COPY[agent].label} MCP servers.`,
        pluginError: `Could not read ${AGENT_EXTENSION_COPY[agent].label} plugins.`,
      },
  );
}

export function EnvironmentSettingsDialog({
  open,
  onOpenChange,
  environment,
  onUpdate,
  onRestart,
}: EnvironmentSettingsDialogProps) {
  const config = useConfigStore((state) => state.config);
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

  // Effective MCP server and plugin state for every supported agent.
  const [extensionCatalogs, setExtensionCatalogs] = useState<
    backend.AgentExtensionCatalog[]
  >(emptyExtensionCatalogs);
  const [isLoadingExtensions, setIsLoadingExtensions] = useState(false);
  const [extensionsError, setExtensionsError] = useState<string | null>(null);
  // Only the newest extension load may write state; see the close effect below.
  const extensionLoadSeq = useRef(0);

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
      // Abandon any in-flight load too. This dialog instance is shared across
      // environments, so a late response would repopulate the panel after it
      // was cleared and surface one environment's extensions under the next.
      extensionLoadSeq.current += 1;
      setExtensionCatalogs(emptyExtensionCatalogs());
      setExtensionsError(null);
      setIsLoadingExtensions(false);
    }
  }, [open]);

  const loadExtensions = useCallback(async (options: { refresh?: boolean } = {}) => {
    const seq = ++extensionLoadSeq.current;
    const isCurrent = () => seq === extensionLoadSeq.current;
    setIsLoadingExtensions(true);
    setExtensionsError(null);
    try {
      const catalogs = await backend.getEnvironmentExtensions(environment.id, options);
      if (!isCurrent()) return;
      setExtensionCatalogs(orderExtensionCatalogs(catalogs));
    } catch (err) {
      if (!isCurrent()) return;
      console.error("[EnvironmentSettingsDialog] Failed to fetch extensions:", err);
      setExtensionCatalogs(emptyExtensionCatalogs());
      setExtensionsError(
        "Extension settings could not be loaded. Check that the environment is available and try again.",
      );
    } finally {
      if (isCurrent()) setIsLoadingExtensions(false);
    }
  }, [environment.id]);

  // The backend owns discovery so this snapshot remains correct even if no
  // agent chat tab is mounted or its live events were missed while inactive.
  useEffect(() => {
    if (!open) return;
    void loadExtensions();
  }, [open, loadExtensions]);

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
  const hasErrors = nameError !== null || domainErrors.length > 0;

  const menuItems: SettingsMenuItem[] = [
    { id: "general", label: "General", icon: <Settings2 className="h-4 w-4" /> },
    { id: "agent", label: "Agent", icon: <Bot className="h-4 w-4" /> },
    ...(!isLocalEnvironment ? [
      { id: "network", label: "Network", icon: <Shield className="h-4 w-4" /> },
      { id: "ports", label: "Ports", icon: <Network className="h-4 w-4" /> },
    ] : []),
    { id: "extensions", label: "Extensions", icon: <Puzzle className="h-4 w-4" /> },
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
                  { value: "codex", label: "Codex", icon: <CodexIcon className="h-4 w-4 text-emerald-400" /> },
                  { value: "opencode", label: "OpenCode", icon: <OpenCodeIcon className="h-4 w-4" /> },
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
          <div className="max-w-5xl space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium">Agent extensions</p>
                <p className="text-xs text-muted-foreground">
                  Effective MCP servers and plugins for this environment.
                  Refreshing health-checks Claude&apos;s approved MCP servers,
                  which starts each one.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void loadExtensions({ refresh: true })}
                disabled={isLoadingExtensions}
              >
                {isLoadingExtensions ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-3.5 w-3.5" />
                )}
                Refresh
              </Button>
            </div>
            {extensionsError && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{extensionsError}</span>
              </div>
            )}
            {isLoadingExtensions &&
            extensionCatalogs.every(
              (catalog) =>
                catalog.mcpServers.length === 0 && catalog.plugins.length === 0,
            ) ? (
              <div className="flex items-center gap-2 rounded-xl border border-border/80 px-4 py-8 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Reading Claude, Codex, and OpenCode configuration…
              </div>
            ) : (
              <div className="space-y-3">
                {extensionCatalogs.map((catalog) => (
                  <AgentExtensionSection
                    key={catalog.agent}
                    catalog={catalog}
                  />
                ))}
              </div>
            )}
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
        <AlertDialogContent
          className={Z_FULLSCREEN_DIALOG}
          overlayClassName={Z_FULLSCREEN_DIALOG}
        >
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
