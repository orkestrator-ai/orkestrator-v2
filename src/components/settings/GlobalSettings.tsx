import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConfigStore } from "@/stores";
import * as backend from "@/lib/backend";
import { Loader2, Eye, EyeOff, Key, Github, CheckCircle2, XCircle, AlertCircle, Code2, Check, Terminal, Bot, FolderOpen, ExternalLink, Globe2, WifiOff } from "lucide-react";
import { ClaudeIcon, CodexIcon, OpenCodeIcon } from "@/components/icons/AgentIcons";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { getGatewayTokenValidationError } from "@/lib/gateway-token";
import type {
  ClaudeMode,
  ClaudeNativeBackend,
  CodexMode,
  DefaultAgent,
  DomainTestResult,
  GatewayTokenSettings,
  OpenCodeMode,
  PreferredEditor,
  TerminalAppearance,
  WebClientStatus,
} from "@/types";
import {
  DEFAULT_TERMINAL_APPEARANCE,
  DEFAULT_TERMINAL_SCROLLBACK,
  FONT_OPTIONS,
  isValidHexColor,
  getPreviewColors,
} from "@/constants/terminal";

// Domain validation regex
const DOMAIN_REGEX = /^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

interface GlobalSettingsProps {
  activeSection: string;
  onSaveSuccess?: () => void;
}

export function GlobalSettings({ activeSection, onSaveSuccess }: GlobalSettingsProps) {
  const { config, setConfig } = useConfigStore();
  const global = config.global;

  const [cpuCores, setCpuCores] = useState(global.containerResources.cpuCores);
  const [memoryGb, setMemoryGb] = useState(global.containerResources.memoryGb);
  const [envPatterns, setEnvPatterns] = useState(global.envFilePatterns.join(", "));
  const [anthropicApiKey, setAnthropicApiKey] = useState(global.anthropicApiKey || "");
  const [githubToken, setGithubToken] = useState(global.githubToken || "");
  const [allowedDomains, setAllowedDomains] = useState(
    (global.allowedDomains || []).join("\n")
  );
  const [preferredEditor, setPreferredEditor] = useState<PreferredEditor>(
    global.preferredEditor || "vscode"
  );
  const [defaultAgent, setDefaultAgent] = useState<DefaultAgent>(
    global.defaultAgent || "claude"
  );
  const [opencodeModel, setOpencodeModel] = useState(
    global.opencodeModel || "opencode/claude-sonnet-5"
  );
  const [opencodeMode, setOpencodeMode] = useState<OpenCodeMode>(
    global.opencodeMode || "terminal"
  );
  const [claudeMode, setClaudeMode] = useState<ClaudeMode>(
    global.claudeMode || "terminal"
  );
  const [claudeNativeBackend, setClaudeNativeBackend] = useState<ClaudeNativeBackend>(
    global.claudeNativeBackend || "sdk"
  );
  const [claudeNativeFastModeDefault, setClaudeNativeFastModeDefault] = useState(
    global.claudeNativeFastModeDefault ?? false
  );
  const [codexMode, setCodexMode] = useState<CodexMode>(
    global.codexMode || "native"
  );
  const [codexNativeFastModeDefault, setCodexNativeFastModeDefault] = useState(
    global.codexNativeFastModeDefault ?? false
  );
  const [terminalFontFamily, setTerminalFontFamily] = useState(
    global.terminalAppearance?.fontFamily || DEFAULT_TERMINAL_APPEARANCE.fontFamily
  );
  const [terminalFontSize, setTerminalFontSize] = useState(
    global.terminalAppearance?.fontSize || DEFAULT_TERMINAL_APPEARANCE.fontSize
  );
  const [terminalBackgroundColor, setTerminalBackgroundColor] = useState(
    global.terminalAppearance?.backgroundColor || DEFAULT_TERMINAL_APPEARANCE.backgroundColor
  );
  const [terminalScrollback, setTerminalScrollback] = useState(
    typeof global.terminalScrollback === "number"
      ? global.terminalScrollback
      : DEFAULT_TERMINAL_SCROLLBACK
  );
  const [experimentalCodexRawEventLogging, setExperimentalCodexRawEventLogging] = useState(
    global.experimentalCodexRawEventLogging ?? true
  );
  const [debugLogging, setDebugLogging] = useState(global.debugLogging ?? false);
  const [webClientEnabled, setWebClientEnabled] = useState(global.webClientEnabled ?? true);
  const [webClientStatus, setWebClientStatus] = useState<WebClientStatus | null>(null);
  const [gatewayTokenSettings, setGatewayTokenSettings] = useState<GatewayTokenSettings | null>(null);
  const [gatewayToken, setGatewayToken] = useState("");
  const [savedGatewayToken, setSavedGatewayToken] = useState("");
  const [gatewayTokenLoadError, setGatewayTokenLoadError] = useState<string | null>(null);
  const [isLoadingWebClientStatus, setIsLoadingWebClientStatus] = useState(false);
  const [isLoadingGatewayToken, setIsLoadingGatewayToken] = useState(false);
  const [logDirectory, setLogDirectory] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [showGithubToken, setShowGithubToken] = useState(false);
  const [showGatewayToken, setShowGatewayToken] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [domainErrors, setDomainErrors] = useState<string[]>([]);
  const [colorError, setColorError] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [testResults, setTestResults] = useState<DomainTestResult[] | null>(null);
  const webClientStatusRequestRef = useRef(0);

  // Sync local state when config changes in the store
  useEffect(() => {
    setCpuCores(global.containerResources.cpuCores);
    setMemoryGb(global.containerResources.memoryGb);
    setEnvPatterns(global.envFilePatterns.join(", "));
    setAnthropicApiKey(global.anthropicApiKey || "");
    setGithubToken(global.githubToken || "");
    setAllowedDomains((global.allowedDomains || []).join("\n"));
    setPreferredEditor(global.preferredEditor || "vscode");
    setDefaultAgent(global.defaultAgent || "claude");
    setOpencodeModel(global.opencodeModel || "opencode/claude-sonnet-5");
    setOpencodeMode(global.opencodeMode || "terminal");
    setClaudeMode(global.claudeMode || "terminal");
    setClaudeNativeBackend(global.claudeNativeBackend || "sdk");
    setClaudeNativeFastModeDefault(global.claudeNativeFastModeDefault ?? false);
    setCodexMode(global.codexMode || "native");
    setCodexNativeFastModeDefault(global.codexNativeFastModeDefault ?? false);
    setTerminalFontFamily(global.terminalAppearance?.fontFamily || DEFAULT_TERMINAL_APPEARANCE.fontFamily);
    setTerminalFontSize(global.terminalAppearance?.fontSize || DEFAULT_TERMINAL_APPEARANCE.fontSize);
    setTerminalBackgroundColor(global.terminalAppearance?.backgroundColor || DEFAULT_TERMINAL_APPEARANCE.backgroundColor);
    setTerminalScrollback(
      typeof global.terminalScrollback === "number"
        ? global.terminalScrollback
        : DEFAULT_TERMINAL_SCROLLBACK
    );
    setExperimentalCodexRawEventLogging(global.experimentalCodexRawEventLogging ?? true);
    setDebugLogging(global.debugLogging ?? false);
    setWebClientEnabled(global.webClientEnabled ?? true);
  }, [global]);

  const refreshWebClientStatus = useCallback(async () => {
    const requestId = ++webClientStatusRequestRef.current;
    setIsLoadingWebClientStatus(true);
    setIsLoadingGatewayToken(true);
    setGatewayTokenLoadError(null);

    const statusRequest = backend.getWebClientStatus()
      .then((status) => {
        if (requestId === webClientStatusRequestRef.current) setWebClientStatus(status);
      })
      .catch((error: unknown) => {
        if (requestId === webClientStatusRequestRef.current) {
          setWebClientStatus({
            enabled: global.webClientEnabled ?? true,
            running: false,
            url: null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })
      .finally(() => {
        if (requestId === webClientStatusRequestRef.current) setIsLoadingWebClientStatus(false);
      });

    const tokenRequest = backend.getGatewayTokenSettings()
      .then((settings) => {
        if (requestId !== webClientStatusRequestRef.current) return;
        setGatewayTokenSettings(settings);
        setGatewayToken(settings.token);
        setSavedGatewayToken(settings.token);
      })
      .catch((error: unknown) => {
        if (requestId === webClientStatusRequestRef.current) {
          setGatewayTokenLoadError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (requestId === webClientStatusRequestRef.current) setIsLoadingGatewayToken(false);
      });

    await Promise.all([statusRequest, tokenRequest]);
  }, [global.webClientEnabled]);

  useEffect(() => {
    if (activeSection === "web-client") void refreshWebClientStatus();
    return () => {
      webClientStatusRequestRef.current += 1;
    };
  }, [activeSection, refreshWebClientStatus]);

  // Fetch log directory path once on mount
  useEffect(() => {
    backend.getLogDirectory().then(setLogDirectory).catch(() => {});
  }, []);

  // Check for changes
  useEffect(() => {
    const terminalAppearance = global.terminalAppearance || DEFAULT_TERMINAL_APPEARANCE;
    const changed =
      cpuCores !== global.containerResources.cpuCores ||
      memoryGb !== global.containerResources.memoryGb ||
      envPatterns !== global.envFilePatterns.join(", ") ||
      anthropicApiKey !== (global.anthropicApiKey || "") ||
      githubToken !== (global.githubToken || "") ||
      allowedDomains !== (global.allowedDomains || []).join("\n") ||
      preferredEditor !== (global.preferredEditor || "vscode") ||
      defaultAgent !== (global.defaultAgent || "claude") ||
      opencodeModel !== (global.opencodeModel || "opencode/claude-sonnet-5") ||
      opencodeMode !== (global.opencodeMode || "terminal") ||
      claudeMode !== (global.claudeMode || "terminal") ||
      claudeNativeBackend !== (global.claudeNativeBackend || "sdk") ||
      claudeNativeFastModeDefault !== (global.claudeNativeFastModeDefault ?? false) ||
      codexMode !== (global.codexMode || "native") ||
      codexNativeFastModeDefault !== (global.codexNativeFastModeDefault ?? false) ||
      terminalFontFamily !== terminalAppearance.fontFamily ||
      terminalFontSize !== terminalAppearance.fontSize ||
      terminalBackgroundColor !== terminalAppearance.backgroundColor ||
      terminalScrollback !== (global.terminalScrollback ?? DEFAULT_TERMINAL_SCROLLBACK) ||
      experimentalCodexRawEventLogging !== (global.experimentalCodexRawEventLogging ?? true) ||
      debugLogging !== (global.debugLogging ?? false) ||
      webClientEnabled !== (global.webClientEnabled ?? true) ||
      gatewayToken !== savedGatewayToken;
    setHasChanges(changed);
    if (changed) {
      setSaveSuccess(false);
    }
  }, [cpuCores, memoryGb, envPatterns, anthropicApiKey, githubToken, allowedDomains, preferredEditor, defaultAgent, opencodeModel, opencodeMode, claudeMode, claudeNativeBackend, claudeNativeFastModeDefault, codexMode, codexNativeFastModeDefault, terminalFontFamily, terminalFontSize, terminalBackgroundColor, terminalScrollback, experimentalCodexRawEventLogging, debugLogging, webClientEnabled, gatewayToken, savedGatewayToken, global]);

  // Validate domains on change
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

  const handleDomainsChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setAllowedDomains(value);
    validateDomainsLocally(value);
  };

  const handleBackgroundColorChange = (value: string) => {
    setTerminalBackgroundColor(value);
    if (value && !isValidHexColor(value)) {
      setColorError("Invalid hex color format. Use #RGB or #RRGGBB.");
    } else {
      setColorError(null);
    }
  };

  const handleTestDomains = async () => {
    const domains = allowedDomains
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
      console.error("[settings] Failed to test domains:", err);
    } finally {
      setIsTesting(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const patterns = envPatterns
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);

      const domains = allowedDomains
        .split("\n")
        .map((d) => d.trim())
        .filter((d) => d.length > 0);

      const newGlobal: {
        containerResources: { cpuCores: number; memoryGb: number };
        envFilePatterns: string[];
        allowedDomains: string[];
        anthropicApiKey?: string;
        githubToken?: string;
        preferredEditor?: PreferredEditor;
        defaultAgent: DefaultAgent;
        opencodeModel: string;
        claudeModel: string;
        codexModel: string;
        codexReasoningEffort:
          | "minimal"
          | "low"
          | "medium"
          | "high"
          | "xhigh"
          | "max"
          | "ultra";
        opencodeMode: OpenCodeMode;
        claudeMode: ClaudeMode;
        claudeNativeBackend: ClaudeNativeBackend;
        claudeNativeFastModeDefault: boolean;
        codexMode: CodexMode;
        codexNativeFastModeDefault: boolean;
        terminalAppearance: TerminalAppearance;
        terminalScrollback: number;
        experimentalCodexRawEventLogging: boolean;
        debugLogging: boolean;
        webClientEnabled: boolean;
      } = {
        containerResources: { cpuCores, memoryGb },
        envFilePatterns: patterns,
        allowedDomains: domains,
        preferredEditor,
        defaultAgent,
        opencodeModel,
        claudeModel: global.claudeModel || "claude-sonnet-5",
        codexModel: global.codexModel || "gpt-5.4",
        codexReasoningEffort: global.codexReasoningEffort || "medium",
        opencodeMode,
        claudeMode,
        claudeNativeBackend,
        claudeNativeFastModeDefault,
        codexMode,
        codexNativeFastModeDefault,
        terminalAppearance: {
          fontFamily: terminalFontFamily,
          fontSize: terminalFontSize,
          backgroundColor: terminalBackgroundColor,
        },
        terminalScrollback,
        experimentalCodexRawEventLogging,
        debugLogging,
        webClientEnabled,
      };

      if (anthropicApiKey) newGlobal.anthropicApiKey = anthropicApiKey;
      if (githubToken) newGlobal.githubToken = githubToken;

      const newConfig = await backend.updateGlobalConfig(newGlobal);
      setConfig(newConfig);

      if (gatewayTokenSettings?.editable && gatewayToken !== savedGatewayToken) {
        const nextGatewayTokenSettings = await backend.setGatewayToken(gatewayToken);
        setGatewayTokenSettings(nextGatewayTokenSettings);
        setGatewayToken(nextGatewayTokenSettings.token);
        setSavedGatewayToken(nextGatewayTokenSettings.token);
      }

      if (!window.orkestratorGateway?.enabled) {
        const nextWebClientStatus = await backend.setWebClientEnabled(webClientEnabled);
        setWebClientStatus(nextWebClientStatus);
      }

      // Propagate GitHub token to running containers if it changed
      const oldToken = global.githubToken || "";
      const newTokenValue = githubToken || "";
      if (oldToken !== newTokenValue) {
        try {
          const propagateResult = await backend.propagateGithubTokenToContainers(
            newTokenValue === "" ? null : newTokenValue
          );
          if (propagateResult.updated.length > 0) {
            toast.success(`Updated GitHub token in ${propagateResult.updated.length} container(s)`);
          }
        } catch (err) {
          console.error("[settings] Failed to propagate token:", err);
        }
      }

      setHasChanges(false);
      setSaveSuccess(true);
      toast.success("Settings saved");
      setTimeout(() => { onSaveSuccess?.(); }, 500);
    } catch (err) {
      console.error("[settings] Failed to save config:", err);
      const message = err instanceof Error ? err.message : "Failed to save settings";
      toast.error("Failed to save settings", { description: message });
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    setCpuCores(global.containerResources.cpuCores);
    setMemoryGb(global.containerResources.memoryGb);
    setEnvPatterns(global.envFilePatterns.join(", "));
    setAnthropicApiKey(global.anthropicApiKey || "");
    setGithubToken(global.githubToken || "");
    setAllowedDomains((global.allowedDomains || []).join("\n"));
    setPreferredEditor(global.preferredEditor || "vscode");
    setDefaultAgent(global.defaultAgent || "claude");
    setOpencodeModel(global.opencodeModel || "opencode/claude-sonnet-5");
    setOpencodeMode(global.opencodeMode || "terminal");
    setClaudeMode(global.claudeMode || "terminal");
    setClaudeNativeBackend(global.claudeNativeBackend || "sdk");
    setClaudeNativeFastModeDefault(global.claudeNativeFastModeDefault ?? false);
    setCodexMode(global.codexMode || "native");
    setCodexNativeFastModeDefault(global.codexNativeFastModeDefault ?? false);
    setTerminalFontFamily(global.terminalAppearance?.fontFamily || DEFAULT_TERMINAL_APPEARANCE.fontFamily);
    setTerminalFontSize(global.terminalAppearance?.fontSize || DEFAULT_TERMINAL_APPEARANCE.fontSize);
    setTerminalBackgroundColor(global.terminalAppearance?.backgroundColor || DEFAULT_TERMINAL_APPEARANCE.backgroundColor);
    setTerminalScrollback(
      typeof global.terminalScrollback === "number"
        ? global.terminalScrollback
        : DEFAULT_TERMINAL_SCROLLBACK
    );
    setExperimentalCodexRawEventLogging(global.experimentalCodexRawEventLogging ?? true);
    setDebugLogging(global.debugLogging ?? false);
    setWebClientEnabled(global.webClientEnabled ?? true);
    setGatewayToken(savedGatewayToken);
    setDomainErrors([]);
    setColorError(null);
    setTestResults(null);
  };

  // --- Section renderers ---

  const renderGeneral = () => (
    <div className="max-w-2xl space-y-8">
      {/* Preferred Editor */}
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
            <Code2 className="h-4 w-4" />
            Preferred Editor
          </h3>
          <p className="text-xs text-muted-foreground mt-1">Editor for "Open in Editor" (Cmd+O)</p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => setPreferredEditor("vscode")}
            className={cn(
              "p-3 rounded-lg border-2 text-left transition-colors",
              preferredEditor === "vscode"
                ? "border-primary bg-primary/5"
                : "border-transparent bg-zinc-900 hover:border-zinc-600"
            )}
          >
            <div className="flex items-center gap-2 font-medium text-sm">
              <Code2 className="h-4 w-4" />
              VS Code
            </div>
          </button>
          <button
            type="button"
            onClick={() => setPreferredEditor("cursor")}
            className={cn(
              "p-3 rounded-lg border-2 text-left transition-colors",
              preferredEditor === "cursor"
                ? "border-primary bg-primary/5"
                : "border-transparent bg-zinc-900 hover:border-zinc-600"
            )}
          >
            <div className="flex items-center gap-2 font-medium text-sm">
              <Code2 className="h-4 w-4" />
              Cursor
            </div>
          </button>
        </div>
        <span className="block text-xs text-muted-foreground/60">
          *Requires the Dev Containers extension
        </span>
      </div>

      {/* Default Agent */}
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
            <Bot className="h-4 w-4" />
            Default Agent
          </h3>
          <p className="text-xs text-muted-foreground mt-1">Agent to launch in new environments</p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => setDefaultAgent("claude")}
            className={cn(
              "p-3 rounded-lg border-2 text-left transition-colors",
              defaultAgent === "claude"
                ? "border-primary bg-primary/5"
                : "border-transparent bg-zinc-900 hover:border-zinc-600"
            )}
          >
            <div className="flex items-center gap-2 font-medium text-sm">
              <ClaudeIcon />
              Claude
            </div>
          </button>
          <button
            type="button"
            onClick={() => setDefaultAgent("opencode")}
            className={cn(
              "p-3 rounded-lg border-2 text-left transition-colors",
              defaultAgent === "opencode"
                ? "border-primary bg-primary/5"
                : "border-transparent bg-zinc-900 hover:border-zinc-600"
            )}
          >
            <div className="flex items-center gap-2 font-medium text-sm">
              <OpenCodeIcon className="h-4.5 w-4.5" />
              OpenCode
            </div>
          </button>
          <button
            type="button"
            onClick={() => setDefaultAgent("codex")}
            className={cn(
              "p-3 rounded-lg border-2 text-left transition-colors",
              defaultAgent === "codex"
                ? "border-primary bg-primary/5"
                : "border-transparent bg-zinc-900 hover:border-zinc-600"
            )}
          >
            <div className="flex items-center gap-2 font-medium text-sm">
              <CodexIcon className="text-emerald-400" />
              Codex
            </div>
          </button>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
            <Github className="h-4 w-4" />
            GitHub Token
          </h3>
          <p className="text-xs text-muted-foreground mt-1">For cloning private repos and pushing via HTTPS</p>
        </div>
        <div className="relative">
          <Input
            type={showGithubToken ? "text" : "password"}
            value={githubToken}
            onChange={(e) => setGithubToken(e.target.value)}
            placeholder="ghp_..."
            className="pr-10 font-mono"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
            onClick={() => setShowGithubToken(!showGithubToken)}
          >
            {showGithubToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Create at{" "}
          <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
            github.com/settings/tokens
          </a>
        </p>
      </div>

      {/* Environment Files */}
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">Environment Files</h3>
          <p className="text-xs text-muted-foreground mt-1">File patterns for .env files to copy (comma-separated)</p>
        </div>
        <Input
          value={envPatterns}
          onChange={(e) => setEnvPatterns(e.target.value)}
          placeholder=".env, .env.local"
        />
        <p className="text-xs text-muted-foreground">
          Files matching these patterns will be copied into containers
        </p>
      </div>
    </div>
  );

  const renderModeToggle = (
    mode: "terminal" | "native",
    setMode: (m: "terminal" | "native") => void,
    description: string,
  ) => (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm text-muted-foreground">{description}</p>
      <div className="grid grid-cols-2 gap-3 max-w-xs">
        <button
          type="button"
          onClick={() => setMode("terminal")}
          className={cn(
            "p-3 rounded-lg border-2 text-left transition-colors",
            mode === "terminal"
              ? "border-primary bg-primary/5"
              : "border-transparent bg-zinc-900 hover:border-zinc-600"
          )}
        >
          <div className="flex items-center gap-2 text-sm font-medium">
            <Terminal className="h-4 w-4" />
            Terminal
          </div>
        </button>
        <button
          type="button"
          onClick={() => setMode("native")}
          className={cn(
            "p-3 rounded-lg border-2 text-left transition-colors",
            mode === "native"
              ? "border-primary bg-primary/5"
              : "border-transparent bg-zinc-900 hover:border-zinc-600"
          )}
        >
          <div className="flex items-center gap-2 text-sm font-medium">
            <Bot className="h-4 w-4" />
            Native
          </div>
        </button>
      </div>
      <p className="text-xs text-muted-foreground/60">
        Native mode opens a chat interface instead of terminal
      </p>
    </div>
  );

  const renderFastModeDefault = (
    enabled: boolean,
    setEnabled: (enabled: boolean) => void,
    agentName: string,
  ) => (
    <div className="max-w-2xl space-y-3">
      <div>
        <h3 className="text-sm font-medium text-foreground">New Native Tabs</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Start new {agentName} Native tabs in default mode or fast mode.
        </p>
      </div>
      <div className="flex items-center justify-between max-w-xs rounded-lg border border-zinc-800 bg-zinc-900 p-3">
        <div className="space-y-0.5">
          <Label className="text-sm">{enabled ? "Fast mode" : "Default mode"}</Label>
          <p className="text-xs text-muted-foreground">
            {enabled ? "Fast mode starts on for new native tabs" : "Fast mode stays off for new native tabs"}
          </p>
        </div>
        <Switch
          aria-label={`${agentName} fast mode for new native tabs`}
          checked={enabled}
          onCheckedChange={setEnabled}
        />
      </div>
    </div>
  );

  const renderClaudeNativeBackendPicker = () => (
    <div className="max-w-2xl space-y-3">
      <div>
        <h3 className="text-sm font-medium text-foreground">Native backend</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Implementation behind &ldquo;Native&rdquo; mode. Repo and environment
          settings can override this; the most specific override wins.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 max-w-md">
        {([
          {
            value: "sdk",
            label: "Agent SDK",
            hint: "Uses the Claude Agent SDK via bridge server",
          },
          {
            value: "tmux",
            label: "Tmux",
            hint: "Drives the Claude CLI under tmux (Max plan friendly)",
          },
        ] as const).map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setClaudeNativeBackend(opt.value)}
            className={cn(
              "p-3 rounded-lg border-2 text-left transition-colors",
              claudeNativeBackend === opt.value
                ? "border-primary bg-primary/5"
                : "border-transparent bg-zinc-900 hover:border-zinc-600",
            )}
          >
            <div className="text-sm font-medium">{opt.label}</div>
            <div className="text-xs text-muted-foreground mt-1">{opt.hint}</div>
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground/60">
        With Tmux: while a session is running, Orkestrator merges a{" "}
        <code className="font-mono px-1">hooks</code> block into the
        environment&apos;s{" "}
        <code className="font-mono px-1">.claude/settings.local.json</code>; the
        original file is restored when the session stops.
      </p>
    </div>
  );

  const renderClaude = () => (
    <div className="max-w-2xl space-y-8">
      {renderModeToggle(claudeMode, setClaudeMode, "Choose how Claude runs in environments")}
      {renderClaudeNativeBackendPicker()}
      {renderFastModeDefault(
        claudeNativeFastModeDefault,
        setClaudeNativeFastModeDefault,
        "Claude",
      )}

      {/* Anthropic API Key */}
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
            <Key className="h-4 w-4" />
            Anthropic API Key
          </h3>
          <p className="text-xs text-muted-foreground mt-1">Required for Claude Code inside containers</p>
        </div>
        <div className="relative">
          <Input
            type={showApiKey ? "text" : "password"}
            value={anthropicApiKey}
            onChange={(e) => setAnthropicApiKey(e.target.value)}
            placeholder="sk-ant-..."
            className="pr-10 font-mono"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
            onClick={() => setShowApiKey(!showApiKey)}
          >
            {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Get key from{" "}
          <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
            console.anthropic.com
          </a>
        </p>
      </div>
    </div>
  );

  const renderOpenCode = () => renderModeToggle(
    opencodeMode,
    setOpencodeMode,
    "Choose how OpenCode runs in environments",
  );

  const renderCodex = () => (
    <div className="max-w-2xl space-y-8">
      {renderModeToggle(
        codexMode,
        setCodexMode,
        "Choose how Codex runs in environments",
      )}
      {renderFastModeDefault(
        codexNativeFastModeDefault,
        setCodexNativeFastModeDefault,
        "Codex",
      )}
    </div>
  );

  const renderTerminal = () => {
    const previewColors = getPreviewColors(terminalBackgroundColor);
    return (
      <div className="max-w-2xl space-y-8">
        {/* Font Family */}
        <div className="space-y-3">
          <Label>Font Family</Label>
          <Select value={terminalFontFamily} onValueChange={setTerminalFontFamily}>
            <SelectTrigger className="w-full max-w-xs">
              <SelectValue placeholder="Select font" />
            </SelectTrigger>
            <SelectContent>
              {FONT_OPTIONS.map((font) => (
                <SelectItem key={font.value} value={font.value}>
                  <span style={{ fontFamily: font.value }}>{font.label}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            FiraCode Nerd Font is bundled with the app. Other fonts must be installed on your system.
          </p>
        </div>

        {/* Font Size */}
        <div className="space-y-3">
          <div className="flex justify-between max-w-xs">
            <Label>Font Size</Label>
            <span className="text-sm font-medium">{terminalFontSize}px</span>
          </div>
          <Slider
            value={[terminalFontSize]}
            onValueChange={([v]) => v !== undefined && setTerminalFontSize(v)}
            min={10}
            max={24}
            step={1}
            className="max-w-xs"
          />
        </div>

        {/* Scrollback Buffer */}
        <div className="space-y-3">
          <div className="flex justify-between max-w-xs">
            <Label>Scrollback Buffer</Label>
            <span className="text-sm font-medium">{terminalScrollback.toLocaleString()} lines</span>
          </div>
          <Slider
            value={[terminalScrollback]}
            onValueChange={([v]) => v !== undefined && setTerminalScrollback(v)}
            min={100}
            max={20000}
            step={100}
            className="max-w-xs"
          />
          <p className="text-xs text-muted-foreground">
            More lines keep more history but use more memory.
          </p>
        </div>

        {/* Background Color */}
        <div className="space-y-3">
          <Label>Background Color</Label>
          <div className="flex gap-3 items-center">
            <Input
              type="color"
              value={
                isValidHexColor(terminalBackgroundColor)
                  ? terminalBackgroundColor
                  : DEFAULT_TERMINAL_APPEARANCE.backgroundColor
              }
              onChange={(e) => handleBackgroundColorChange(e.target.value)}
              className="w-16 h-10 p-1 cursor-pointer"
            />
            <Input
              type="text"
              value={terminalBackgroundColor}
              onChange={(e) => handleBackgroundColorChange(e.target.value)}
              placeholder={DEFAULT_TERMINAL_APPEARANCE.backgroundColor}
              className={cn("font-mono w-32", colorError && "border-red-500")}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => handleBackgroundColorChange(DEFAULT_TERMINAL_APPEARANCE.backgroundColor)}
            >
              Reset
            </Button>
          </div>
          {colorError && (
            <div className="text-sm text-red-500 flex items-center gap-1">
              <XCircle className="h-3 w-3" />
              {colorError}
            </div>
          )}
        </div>

        {/* Preview */}
        <div className="space-y-3">
          <Label>Preview</Label>
          <div
            className="rounded-md p-4 border border-zinc-800 max-w-md"
            style={{
              backgroundColor: isValidHexColor(terminalBackgroundColor)
                ? terminalBackgroundColor
                : DEFAULT_TERMINAL_APPEARANCE.backgroundColor,
              fontFamily: `"${terminalFontFamily}", "Fira Code", monospace`,
              fontSize: `${terminalFontSize}px`,
              color: previewColors.foreground,
              lineHeight: 1.4,
            }}
          >
            <div><span style={{ color: previewColors.prompt }}>$</span> echo "Hello"</div>
            <div>Hello</div>
          </div>
        </div>
      </div>
    );
  };

  const renderNetwork = () => (
    <div className="max-w-2xl space-y-4">
      <div>
        <h3 className="text-sm font-medium text-foreground">Network Whitelist</h3>
        <p className="text-xs text-muted-foreground mt-1">Domains allowed in "Restricted" mode (one per line)</p>
      </div>
      <Textarea
        value={allowedDomains}
        onChange={handleDomainsChange}
        placeholder={"github.com\nregistry.npmjs.org\napi.anthropic.com"}
        rows={8}
        className={cn("font-mono text-sm", domainErrors.length > 0 && "border-red-500")}
      />

      {domainErrors.length > 0 && (
        <div className="text-sm text-red-500 space-y-1">
          {domainErrors.map((error, i) => (
            <div key={i} className="flex items-center gap-1">
              <XCircle className="h-3 w-3" />
              {error}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleTestDomains}
          disabled={isTesting || domainErrors.length > 0}
        >
          {isTesting ? (
            <>
              <Loader2 className="mr-2 h-3 w-3 animate-spin" />
              Testing...
            </>
          ) : (
            "Test DNS"
          )}
        </Button>
      </div>

      {testResults && (
        <div className="border border-zinc-800 rounded-md p-2 space-y-1 text-xs">
          {testResults.map((result, i) => (
            <div key={i} className="flex items-center gap-1">
              {result.resolvable ? (
                <CheckCircle2 className="h-3 w-3 text-green-500" />
              ) : result.valid ? (
                <AlertCircle className="h-3 w-3 text-yellow-500" />
              ) : (
                <XCircle className="h-3 w-3 text-red-500" />
              )}
              <span className="font-mono">{result.domain}</span>
              {result.error && (
                <span className="text-red-500 ml-1">{result.error}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const renderContainer = () => (
    <div className="max-w-2xl space-y-8">
      <div className="space-y-3">
        <div className="flex justify-between max-w-xs">
          <Label className="text-sm">CPU Cores</Label>
          <span className="text-sm font-medium">{cpuCores}</span>
        </div>
        <Slider
          value={[cpuCores]}
          onValueChange={([v]) => v !== undefined && setCpuCores(v)}
          min={1}
          max={16}
          step={1}
          className="max-w-xs"
        />
      </div>
      <div className="space-y-3">
        <div className="flex justify-between max-w-xs">
          <Label className="text-sm">Memory (GB)</Label>
          <span className="text-sm font-medium">{memoryGb} GB</span>
        </div>
        <Slider
          value={[memoryGb]}
          onValueChange={([v]) => v !== undefined && setMemoryGb(v)}
          min={1}
          max={64}
          step={1}
          className="max-w-xs"
        />
      </div>
    </div>
  );

  const gatewayTokenValidationError = gatewayTokenSettings?.editable
    ? getGatewayTokenValidationError(gatewayToken)
    : null;

  const renderWebClient = () => {
    const isRemoteClient = window.orkestratorGateway?.enabled === true;
    const hasPendingChange = webClientEnabled !== (global.webClientEnabled ?? true);
    const statusLabel = isLoadingWebClientStatus
      ? "Checking"
      : webClientStatus?.running
        ? "Running"
        : webClientStatus?.enabled
          ? "Unavailable"
          : "Off";

    return (
      <div className="max-w-2xl space-y-6">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Globe2 className="h-4 w-4" />
            Web client
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Open Orkestrator from another browser on your Tailscale network.
          </p>
        </div>

        <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/50">
          <div className="flex items-center justify-between gap-6 p-4">
            <div className="min-w-0 space-y-1">
              <Label htmlFor="web-client-enabled" className="text-sm font-medium">
                Allow web access
              </Label>
              <p className="text-xs text-muted-foreground">
                {isRemoteClient
                  ? "This setting can only be changed in the desktop app."
                  : "Starts an authenticated web client on this computer's Tailscale address."}
              </p>
            </div>
            <Switch
              id="web-client-enabled"
              aria-label="Allow web access"
              checked={webClientEnabled}
              disabled={isRemoteClient}
              onCheckedChange={setWebClientEnabled}
            />
          </div>

          <div className="space-y-2 border-t border-zinc-800 p-4">
            <div className="space-y-1">
              <Label htmlFor="gateway-token" className="flex items-center gap-2 text-sm font-medium">
                <Key className="h-3.5 w-3.5" />
                Gateway token
              </Label>
              <p id="gateway-token-description" className="text-xs text-muted-foreground">
                Enter this token when signing in to the web client from another browser.
              </p>
            </div>

            <div className="relative">
              <Input
                id="gateway-token"
                type={showGatewayToken ? "text" : "password"}
                value={gatewayToken}
                onChange={(event) => setGatewayToken(event.target.value)}
                placeholder={isLoadingGatewayToken ? "Loading gateway token…" : "Gateway token"}
                className="pr-10 font-mono text-xs"
                disabled={isLoadingGatewayToken || !gatewayTokenSettings?.editable || isSaving}
                aria-describedby="gateway-token-description"
                aria-invalid={gatewayTokenValidationError ? true : undefined}
                autoComplete="off"
                spellCheck={false}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2"
                onClick={() => setShowGatewayToken((visible) => !visible)}
                disabled={isLoadingGatewayToken || !gatewayToken}
                aria-label={showGatewayToken ? "Hide gateway token" : "Show gateway token"}
              >
                {showGatewayToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>

            {gatewayTokenValidationError && (
              <p className="text-xs text-destructive">{gatewayTokenValidationError}</p>
            )}
            {gatewayTokenLoadError && (
              <p className="flex items-start gap-1.5 text-xs text-amber-400/90">
                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                {gatewayTokenLoadError}
              </p>
            )}
            {gatewayTokenSettings?.source === "environment" && (
              <p className="text-xs text-muted-foreground">
                This token is managed by <code className="font-mono">ORKESTRATOR_GATEWAY_TOKEN</code> and cannot be changed here.
              </p>
            )}
            {gatewayTokenSettings?.editable && gatewayToken !== savedGatewayToken && !gatewayTokenValidationError && (
              <p className="text-xs text-amber-400/90">
                Save changes to use this token for future sign-ins.
              </p>
            )}
          </div>

          <div aria-live="polite" className="border-t border-zinc-800 bg-zinc-900/60 px-4 py-3">
            <div className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-2">
                {isLoadingWebClientStatus ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                ) : webClientStatus?.running ? (
                  <span className="relative flex h-2.5 w-2.5 shrink-0">
                    <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-40 motion-safe:animate-ping" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
                  </span>
                ) : (
                  <WifiOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="text-xs font-medium text-foreground">{statusLabel}</span>
              </div>

              {webClientStatus?.running && webClientStatus.url && !hasPendingChange && (
                <a
                  href={webClientStatus.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => {
                    if (!isRemoteClient) {
                      event.preventDefault();
                      void backend.openInBrowser(webClientStatus.url!);
                    }
                  }}
                  className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  title={webClientStatus.url}
                >
                  <span className="truncate">{webClientStatus.url}</span>
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </a>
              )}
            </div>

            {hasPendingChange && (
              <p className="mt-2 text-xs text-amber-400/90">
                Save changes to {webClientEnabled ? "start" : "stop"} the web client.
              </p>
            )}
            {!hasPendingChange && webClientStatus?.error && (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-400/90">
                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                {webClientStatus.error}
              </p>
            )}
          </div>
        </div>

        <p className="text-xs leading-relaxed text-muted-foreground/70">
          Access is limited to Tailscale addresses. Changing the token keeps this browser signed in, but other browsers must use the new token on their next sign-in.
        </p>
      </div>
    );
  };

  const renderDebug = () => (
    <div className="max-w-2xl space-y-4">
      <div>
        <h3 className="text-sm font-medium text-foreground">Save Logs for Debugging</h3>
        <p className="text-xs text-muted-foreground mt-1">Write application logs to disk for troubleshooting</p>
      </div>
      <button
        type="button"
        onClick={() => setDebugLogging(!debugLogging)}
        className={cn(
          "max-w-xs w-full p-3 rounded-lg border-2 text-left transition-colors",
          debugLogging
            ? "border-primary bg-primary/5"
            : "border-transparent bg-zinc-900 hover:border-zinc-600"
        )}
      >
        <div className="flex items-center justify-between">
          <span className="font-medium text-sm">
            {debugLogging ? "Enabled" : "Disabled"}
          </span>
          <div
            className={cn(
              "w-9 h-5 rounded-full transition-colors relative",
              debugLogging ? "bg-primary" : "bg-muted-foreground/30"
            )}
          >
            <div
              className={cn(
                "absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform",
                debugLogging ? "translate-x-4" : "translate-x-0.5"
              )}
            />
          </div>
        </div>
      </button>
      {debugLogging && logDirectory && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">Logs will be saved to:</p>
          <button
            type="button"
            onClick={() => { if (logDirectory) backend.revealInFileManager(logDirectory).catch(() => {}); }}
            className="flex items-center gap-1.5 text-xs text-primary hover:underline font-mono truncate max-w-full"
            title={logDirectory}
          >
            <FolderOpen className="h-3 w-3 shrink-0" />
            <span className="truncate">{logDirectory}</span>
          </button>
        </div>
      )}
      <p className="text-xs text-muted-foreground/60">
        Requires app restart to take effect
      </p>
    </div>
  );

  const renderExperimental = () => (
    <div className="max-w-2xl space-y-4">
      <div>
        <h3 className="text-sm font-medium text-foreground">Codex Raw Event Logging</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Captures the additional raw Codex bridge events used to validate transcript-derived subagent rendering.
        </p>
      </div>
      <button
        type="button"
        onClick={() => setExperimentalCodexRawEventLogging(!experimentalCodexRawEventLogging)}
        className={cn(
          "max-w-xs w-full p-3 rounded-lg border-2 text-left transition-colors",
          experimentalCodexRawEventLogging
            ? "border-primary bg-primary/5"
            : "border-transparent bg-zinc-900 hover:border-zinc-600"
        )}
      >
        <div className="flex items-center justify-between">
          <span className="font-medium text-sm">
            {experimentalCodexRawEventLogging ? "Enabled" : "Disabled"}
          </span>
          <div
            className={cn(
              "w-9 h-5 rounded-full transition-colors relative",
              experimentalCodexRawEventLogging ? "bg-primary" : "bg-muted-foreground/30"
            )}
          >
            <div
              className={cn(
                "absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform",
                experimentalCodexRawEventLogging ? "translate-x-4" : "translate-x-0.5"
              )}
            />
          </div>
        </div>
      </button>
      <p className="text-xs text-muted-foreground">
        Leave this enabled while validating subagent transcript rendering. Turn it off later if you no longer want to persist the extra Codex event payloads.
      </p>
      {experimentalCodexRawEventLogging && logDirectory && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">Local environment logs will be saved under:</p>
          <button
            type="button"
            onClick={() => { if (logDirectory) backend.revealInFileManager(logDirectory).catch(() => {}); }}
            className="flex items-center gap-1.5 text-xs text-primary hover:underline font-mono truncate max-w-full"
            title={`${logDirectory}/codex-raw`}
          >
            <FolderOpen className="h-3 w-3 shrink-0" />
            <span className="truncate">{logDirectory}/codex-raw</span>
          </button>
        </div>
      )}
      <p className="text-xs text-muted-foreground/60">
        Requires bridge restart to take effect. Local environment logs are written under the app log directory in `codex-raw/`.
      </p>
    </div>
  );

  const sectionContent: Record<string, () => React.ReactNode> = {
    general: renderGeneral,
    claude: renderClaude,
    opencode: renderOpenCode,
    codex: renderCodex,
    terminal: renderTerminal,
    network: renderNetwork,
    "web-client": renderWebClient,
    container: renderContainer,
    experimental: renderExperimental,
    debug: renderDebug,
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1">
        {sectionContent[activeSection]?.()}
      </div>

      {/* Sticky save bar */}
      <div className="flex justify-end gap-2 pt-6 pb-2 border-t border-zinc-800/50 mt-8">
        <Button variant="outline" onClick={handleReset} disabled={!hasChanges}>
          Reset
        </Button>
        <Button onClick={handleSave} disabled={!hasChanges || isSaving || saveSuccess || domainErrors.length > 0 || !!colorError || !!gatewayTokenValidationError}>
          {saveSuccess ? (
            <>
              <Check className="mr-2 h-4 w-4" />
              Saved!
            </>
          ) : isSaving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving...
            </>
          ) : (
            "Save Changes"
          )}
        </Button>
      </div>
    </div>
  );
}
