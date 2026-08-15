import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConfigStore } from "@/stores";
import * as backend from "@/lib/backend";
import { Loader2, Eye, EyeOff, Key, Github, CheckCircle2, XCircle, AlertCircle, Code2, Check, Terminal, Bot, FolderOpen, ExternalLink, Globe2, WifiOff, Copy, RefreshCw, RotateCcw } from "lucide-react";
import { AgentIcon } from "@/components/agents/AgentRadioGroup";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { getGatewayTokenValidationError } from "@/lib/gateway-token";
import {
  getReviewInstructionValidationError,
  REVIEW_INSTRUCTION_MAX_LENGTH,
  REVIEW_INSTRUCTION_RECOMMENDED_LENGTH,
} from "@orkestrator/protocol/review-instruction";
import { useTimedCopyFeedback } from "@/hooks";
import {
  DEFAULT_REVIEW_INSTRUCTION,
  REVIEW_INSTRUCTION_TARGET_BRANCH_TOKEN,
} from "@/prompts";
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
import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";
import {
  AGENT_PLATFORMS,
  AGENT_PLATFORM_LABELS,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";

// Domain validation regex
const DOMAIN_REGEX = /^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
const DEFAULT_CODEX_MAX_CONCURRENT_THREADS = 5;
// Codex V2 adds the root conversation to this child-only limit.
const MAX_CODEX_CONCURRENT_THREADS = Number.MAX_SAFE_INTEGER - 1;

function getSavedReviewInstruction(value: unknown): string {
  return typeof value === "string" && getReviewInstructionValidationError(value) === null
    ? value
    : DEFAULT_REVIEW_INSTRUCTION;
}

interface GlobalSettingsProps {
  activeSection: string;
  onSaveSuccess?: () => void;
}

export function GlobalSettings({ activeSection, onSaveSuccess }: GlobalSettingsProps) {
  const config = useConfigStore((state) => state.config);
  const setConfig = useConfigStore((state) => state.setConfig);
  const global = config.global;

  const [cpuCores, setCpuCores] = useState(global.containerResources.cpuCores);
  const [memoryGb, setMemoryGb] = useState(global.containerResources.memoryGb);
  const [envPatterns, setEnvPatterns] = useState(global.envFilePatterns.join(", "));
  const [anthropicApiKey, setAnthropicApiKey] = useState(global.anthropicApiKey || "");
  const [cursorApiKey, setCursorApiKey] = useState("");
  const [clearCursorApiKey, setClearCursorApiKey] = useState(false);
  const [useHostGitHubCredentials, setUseHostGitHubCredentials] = useState(
    global.useHostGitHubCredentials ?? true
  );
  const [useHostClaudeCredentials, setUseHostClaudeCredentials] = useState(
    global.useHostClaudeCredentials ?? true
  );
  const [githubToken, setGithubToken] = useState("");
  const [clearGithubToken, setClearGithubToken] = useState(false);
  const [allowedDomains, setAllowedDomains] = useState(
    (global.allowedDomains || []).join("\n")
  );
  const [preferredEditor, setPreferredEditor] = useState<PreferredEditor>(
    global.preferredEditor || "vscode"
  );
  const [defaultAgent, setDefaultAgent] = useState<DefaultAgent>(
    global.defaultAgent || "claude"
  );
  const [enabledAgentPlatforms, setEnabledAgentPlatforms] = useState<AgentPlatform[]>(
    global.enabledAgentPlatforms ?? ["claude", "codex", "opencode"]
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
  const [codexMaxConcurrentThreads, setCodexMaxConcurrentThreads] = useState(
    global.codexMaxConcurrentThreads ?? DEFAULT_CODEX_MAX_CONCURRENT_THREADS
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
  const [reviewInstruction, setReviewInstruction] = useState(
    getSavedReviewInstruction(global.reviewInstruction)
  );
  const [webClientStatus, setWebClientStatus] = useState<WebClientStatus | null>(null);
  const [webClientApplyError, setWebClientApplyError] = useState<string | null>(null);
  const [gatewayTokenSettings, setGatewayTokenSettings] = useState<GatewayTokenSettings | null>(null);
  const [gatewayToken, setGatewayToken] = useState("");
  const [savedGatewayToken, setSavedGatewayToken] = useState("");
  const [gatewayTokenLoadError, setGatewayTokenLoadError] = useState<string | null>(null);
  const [isLoadingWebClientStatus, setIsLoadingWebClientStatus] = useState(false);
  const [isLoadingGatewayToken, setIsLoadingGatewayToken] = useState(false);
  const [logDirectory, setLogDirectory] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [showCursorApiKey, setShowCursorApiKey] = useState(false);
  const [showGithubToken, setShowGithubToken] = useState(false);
  const [showGatewayToken, setShowGatewayToken] = useState(false);
  const { copied: gatewayTokenCopied, copy: copyGatewayToken } = useTimedCopyFeedback();
  const { copied: webClientUrlCopied, copy: copyWebClientUrl } = useTimedCopyFeedback();
  const [isResettingTailscaleServe, setIsResettingTailscaleServe] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [githubCredentialPropagationPending, setGithubCredentialPropagationPending] =
    useState(false);
  const [domainErrors, setDomainErrors] = useState<string[]>([]);
  const [colorError, setColorError] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [testResults, setTestResults] = useState<DomainTestResult[] | null>(null);
  const webClientStatusRequestRef = useRef(0);
  const pendingGitHubCredentialEditRef = useRef<{
    token: string;
    clear: boolean;
  } | null>(null);
  const pendingCursorCredentialEditRef = useRef<{
    apiKey: string;
    clear: boolean;
  } | null>(null);

  // Sync local state when config changes in the store
  useEffect(() => {
    setCpuCores(global.containerResources.cpuCores);
    setMemoryGb(global.containerResources.memoryGb);
    setEnvPatterns(global.envFilePatterns.join(", "));
    setAnthropicApiKey(global.anthropicApiKey || "");
    setCursorApiKey(pendingCursorCredentialEditRef.current?.apiKey ?? "");
    setClearCursorApiKey(pendingCursorCredentialEditRef.current?.clear ?? false);
    setUseHostGitHubCredentials(global.useHostGitHubCredentials ?? true);
    setUseHostClaudeCredentials(global.useHostClaudeCredentials ?? true);
    setGithubToken(pendingGitHubCredentialEditRef.current?.token ?? "");
    setClearGithubToken(pendingGitHubCredentialEditRef.current?.clear ?? false);
    setAllowedDomains((global.allowedDomains || []).join("\n"));
    setPreferredEditor(global.preferredEditor || "vscode");
    setDefaultAgent(global.defaultAgent || "claude");
    setEnabledAgentPlatforms(global.enabledAgentPlatforms ?? ["claude", "codex", "opencode"]);
    setOpencodeModel(global.opencodeModel || "opencode/claude-sonnet-5");
    setOpencodeMode(global.opencodeMode || "terminal");
    setClaudeMode(global.claudeMode || "terminal");
    setClaudeNativeBackend(global.claudeNativeBackend || "sdk");
    setClaudeNativeFastModeDefault(global.claudeNativeFastModeDefault ?? false);
    setCodexMode(global.codexMode || "native");
    setCodexNativeFastModeDefault(global.codexNativeFastModeDefault ?? false);
    setCodexMaxConcurrentThreads(
      global.codexMaxConcurrentThreads ?? DEFAULT_CODEX_MAX_CONCURRENT_THREADS
    );
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
    setReviewInstruction(getSavedReviewInstruction(global.reviewInstruction));
  }, [global]);

  const refreshWebClientStatus = useCallback(async () => {
    const requestId = ++webClientStatusRequestRef.current;
    setIsLoadingWebClientStatus(true);
    setIsLoadingGatewayToken(true);
    setGatewayTokenLoadError(null);

    const statusRequest = backend.getWebClientStatus()
      .then((status) => {
        if (requestId === webClientStatusRequestRef.current) {
          setWebClientStatus(status);
          setWebClientApplyError(null);
        }
      })
      .catch((error: unknown) => {
        if (requestId === webClientStatusRequestRef.current) {
          setWebClientStatus({
            enabled: true,
            running: false,
            url: null,
            error: error instanceof Error ? error.message : String(error),
            resetAvailable: false,
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
  }, []);

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
      cursorApiKey.trim().length > 0 ||
      clearCursorApiKey ||
      useHostGitHubCredentials !== (global.useHostGitHubCredentials ?? true) ||
      useHostClaudeCredentials !== (global.useHostClaudeCredentials ?? true) ||
      githubToken.trim().length > 0 ||
      clearGithubToken ||
      githubCredentialPropagationPending ||
      allowedDomains !== (global.allowedDomains || []).join("\n") ||
      preferredEditor !== (global.preferredEditor || "vscode") ||
      JSON.stringify(enabledAgentPlatforms) !== JSON.stringify(global.enabledAgentPlatforms ?? ["claude", "codex", "opencode"]) ||
      defaultAgent !== (global.defaultAgent || "claude") ||
      opencodeModel !== (global.opencodeModel || "opencode/claude-sonnet-5") ||
      opencodeMode !== (global.opencodeMode || "terminal") ||
      claudeMode !== (global.claudeMode || "terminal") ||
      claudeNativeBackend !== (global.claudeNativeBackend || "sdk") ||
      claudeNativeFastModeDefault !== (global.claudeNativeFastModeDefault ?? false) ||
      codexMode !== (global.codexMode || "native") ||
      codexNativeFastModeDefault !== (global.codexNativeFastModeDefault ?? false) ||
      codexMaxConcurrentThreads !==
        (global.codexMaxConcurrentThreads ?? DEFAULT_CODEX_MAX_CONCURRENT_THREADS) ||
      terminalFontFamily !== terminalAppearance.fontFamily ||
      terminalFontSize !== terminalAppearance.fontSize ||
      terminalBackgroundColor !== terminalAppearance.backgroundColor ||
      terminalScrollback !== (global.terminalScrollback ?? DEFAULT_TERMINAL_SCROLLBACK) ||
      experimentalCodexRawEventLogging !== (global.experimentalCodexRawEventLogging ?? true) ||
      debugLogging !== (global.debugLogging ?? false) ||
      webClientEnabled !== (global.webClientEnabled ?? true) ||
      reviewInstruction !== getSavedReviewInstruction(global.reviewInstruction) ||
      webClientApplyError !== null ||
      gatewayToken !== savedGatewayToken;
    setHasChanges(changed);
    if (changed) {
      setSaveSuccess(false);
    }
  }, [cpuCores, memoryGb, envPatterns, anthropicApiKey, cursorApiKey, clearCursorApiKey, useHostGitHubCredentials, useHostClaudeCredentials, githubToken, clearGithubToken, githubCredentialPropagationPending, allowedDomains, preferredEditor, enabledAgentPlatforms, defaultAgent, opencodeModel, opencodeMode, claudeMode, claudeNativeBackend, claudeNativeFastModeDefault, codexMode, codexNativeFastModeDefault, codexMaxConcurrentThreads, terminalFontFamily, terminalFontSize, terminalBackgroundColor, terminalScrollback, experimentalCodexRawEventLogging, debugLogging, webClientEnabled, reviewInstruction, webClientApplyError, gatewayToken, savedGatewayToken, global]);

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
      // Filenames are case-sensitive, so these dedupe exactly.
      const patterns = [...new Set(envPatterns
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0))];

      // DNS is not case-sensitive, so `example.com` and `Example.com` are one
      // allowed domain. The first spelling the user typed is the one kept.
      const domains: string[] = [];
      const seenDomains = new Set<string>();
      for (const domain of allowedDomains.split("\n").map((d) => d.trim())) {
        if (domain.length === 0 || seenDomains.has(domain.toLowerCase())) continue;
        seenDomains.add(domain.toLowerCase());
        domains.push(domain);
      }

      const newGlobal: {
        containerResources: { cpuCores: number; memoryGb: number };
        envFilePatterns: string[];
        allowedDomains: string[];
        anthropicApiKey?: string;
        useHostGitHubCredentials: boolean;
        useHostClaudeCredentials: boolean;
        preferredEditor?: PreferredEditor;
        enabledAgentPlatforms: AgentPlatform[];
        favoriteModels: Array<{ platform: AgentPlatform; modelId: string }>;
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
        codexMaxConcurrentThreads: number;
        terminalAppearance: TerminalAppearance;
        terminalScrollback: number;
        experimentalCodexRawEventLogging: boolean;
        debugLogging: boolean;
        webClientEnabled: boolean;
        reviewInstruction?: string;
      } = {
        containerResources: { cpuCores, memoryGb },
        envFilePatterns: patterns,
        allowedDomains: domains,
        useHostGitHubCredentials,
        useHostClaudeCredentials,
        preferredEditor,
        enabledAgentPlatforms,
        favoriteModels: global.favoriteModels ?? [],
        defaultAgent,
        opencodeModel,
        claudeModel: global.claudeModel || "claude-sonnet-5",
        codexModel: global.codexModel || "gpt-5.4",
        codexReasoningEffort: global.codexReasoningEffort || "high",
        opencodeMode,
        claudeMode,
        claudeNativeBackend,
        claudeNativeFastModeDefault,
        codexMode,
        codexNativeFastModeDefault,
        codexMaxConcurrentThreads,
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
      if (reviewInstruction !== DEFAULT_REVIEW_INSTRUCTION) {
        newGlobal.reviewInstruction = reviewInstruction;
      }

      let newConfig = await backend.updateGlobalConfig(newGlobal);
      const nextCursorApiKey = cursorApiKey.trim();
      const cursorApiKeyChanged = clearCursorApiKey || nextCursorApiKey.length > 0;
      const nextGitHubToken = githubToken.trim();
      const githubCredentialSourceChanged =
        useHostGitHubCredentials !== (global.useHostGitHubCredentials ?? true);
      const githubTokenChanged = clearGithubToken || nextGitHubToken.length > 0;
      const githubCredentialChanged = githubCredentialSourceChanged || githubTokenChanged;
      if (cursorApiKeyChanged) {
        pendingCursorCredentialEditRef.current = {
          apiKey: cursorApiKey,
          clear: clearCursorApiKey,
        };
      }
      if (githubTokenChanged) {
        // Persisted non-secret settings are already authoritative at this point.
        // Preserve the credential edit across that store sync until its separate
        // keychain/file write succeeds, so a partial failure remains retryable.
        pendingGitHubCredentialEditRef.current = {
          token: githubToken,
          clear: clearGithubToken,
        };
      }
      setConfig(newConfig);
      if (cursorApiKeyChanged) {
        newConfig = await backend.setCursorApiKey(
          clearCursorApiKey ? null : nextCursorApiKey,
        );
        pendingCursorCredentialEditRef.current = null;
        setConfig(newConfig);
      }
      if (githubTokenChanged) {
        newConfig = await backend.setGitHubToken(
          clearGithubToken ? null : nextGitHubToken,
        );
        pendingGitHubCredentialEditRef.current = null;
        setConfig(newConfig);
      }

      if (!window.orkestratorGateway?.enabled) {
        try {
          const nextWebClientStatus = await backend.setWebClientEnabled(webClientEnabled);
          setWebClientStatus(nextWebClientStatus);
          setWebClientApplyError(null);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setWebClientApplyError(message);
          setWebClientStatus((status) => ({
            enabled: webClientEnabled,
            running: status?.running ?? false,
            url: status?.url ?? null,
            error: message,
            resetAvailable: status?.resetAvailable ?? false,
          }));
          throw error;
        }
      }

      if (gatewayTokenSettings?.editable && gatewayToken !== savedGatewayToken) {
        const nextGatewayTokenSettings = await backend.setGatewayToken(gatewayToken);
        setGatewayTokenSettings(nextGatewayTokenSettings);
        setGatewayToken(nextGatewayTokenSettings.token);
        setSavedGatewayToken(nextGatewayTokenSettings.token);
      }

      // Apply the selected credential source to running containers if it changed,
      // or retry a previous partial propagation failure.
      let githubCredentialPropagationFailed = false;
      if (githubCredentialChanged || githubCredentialPropagationPending) {
        try {
          const propagateResult = await backend.propagateGithubCredentialsToContainers();
          if (propagateResult.failed.length > 0) {
            githubCredentialPropagationFailed = true;
            setGithubCredentialPropagationPending(true);
            const failureDetails = propagateResult.failed
              .slice(0, 3)
              .map(([environmentId, message]) => `${environmentId}: ${message}`)
              .join("; ");
            const remainingFailureCount = Math.max(0, propagateResult.failed.length - 3);
            toast.error("Settings saved, but some containers were not updated", {
              description: [
                propagateResult.updated.length > 0
                  ? `Updated ${propagateResult.updated.length} container(s).`
                  : null,
                `Failed: ${failureDetails}${remainingFailureCount > 0 ? `; and ${remainingFailureCount} more` : ""}.`,
                "Save Changes to retry.",
              ].filter(Boolean).join(" "),
            });
          } else {
            setGithubCredentialPropagationPending(false);
          }
          if (propagateResult.updated.length > 0 && propagateResult.failed.length === 0) {
            toast.success(`Updated GitHub credentials in ${propagateResult.updated.length} container(s)`);
          }
        } catch (err) {
          console.error("[settings] Failed to propagate GitHub credentials:", err);
          githubCredentialPropagationFailed = true;
          setGithubCredentialPropagationPending(true);
          const message = err instanceof Error ? err.message : String(err);
          toast.error("Settings saved, but containers were not updated", {
            description: `${message}. Save Changes to retry.`,
          });
        }
      }

      setCursorApiKey("");
      setClearCursorApiKey(false);
      pendingCursorCredentialEditRef.current = null;
      setGithubToken("");
      setClearGithubToken(false);
      pendingGitHubCredentialEditRef.current = null;
      setHasChanges(githubCredentialPropagationFailed);
      setSaveSuccess(!githubCredentialPropagationFailed);
      if (!githubCredentialPropagationFailed) {
        toast.success("Settings saved");
        setTimeout(() => { onSaveSuccess?.(); }, 500);
      }
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
    setCursorApiKey("");
    setClearCursorApiKey(false);
    pendingCursorCredentialEditRef.current = null;
    setUseHostGitHubCredentials(global.useHostGitHubCredentials ?? true);
    setUseHostClaudeCredentials(global.useHostClaudeCredentials ?? true);
    setGithubToken("");
    setClearGithubToken(false);
    // Reset is an explicit discard. Without this the retained edit would be
    // restored by the `[global]` sync effect on the next external config change,
    // resurrecting a token — or a pending clear — the user just threw away.
    pendingGitHubCredentialEditRef.current = null;
    setAllowedDomains((global.allowedDomains || []).join("\n"));
    setPreferredEditor(global.preferredEditor || "vscode");
    setEnabledAgentPlatforms(global.enabledAgentPlatforms ?? ["claude", "codex", "opencode"]);
    setDefaultAgent(global.defaultAgent || "claude");
    setOpencodeModel(global.opencodeModel || "opencode/claude-sonnet-5");
    setOpencodeMode(global.opencodeMode || "terminal");
    setClaudeMode(global.claudeMode || "terminal");
    setClaudeNativeBackend(global.claudeNativeBackend || "sdk");
    setClaudeNativeFastModeDefault(global.claudeNativeFastModeDefault ?? false);
    setCodexMode(global.codexMode || "native");
    setCodexNativeFastModeDefault(global.codexNativeFastModeDefault ?? false);
    setCodexMaxConcurrentThreads(
      global.codexMaxConcurrentThreads ?? DEFAULT_CODEX_MAX_CONCURRENT_THREADS
    );
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
    setReviewInstruction(getSavedReviewInstruction(global.reviewInstruction));
    setWebClientApplyError(null);
    setGatewayToken(savedGatewayToken);
    setDomainErrors([]);
    setColorError(null);
    setTestResults(null);
  };

  // --- Section renderers ---

  const isUsingDefaultReviewInstruction = reviewInstruction === DEFAULT_REVIEW_INSTRUCTION;
  const reviewInstructionValidationError = getReviewInstructionValidationError(reviewInstruction);
  const reviewInstructionApproxTokens = Math.ceil(reviewInstruction.length / 4);
  const reviewInstructionIsLong =
    reviewInstruction.length > REVIEW_INSTRUCTION_RECOMMENDED_LENGTH;
  const reviewInstructionWarningVisible =
    reviewInstructionIsLong && !reviewInstructionValidationError;
  const reviewInstructionDescribedBy = [
    "review-instruction-description",
    "review-instruction-status",
    reviewInstructionWarningVisible ? "review-instruction-warning" : null,
  ].filter(Boolean).join(" ");

  const renderReview = () => (
    <div className="max-w-3xl space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Eye className="h-4 w-4" />
            Code review instruction
          </h3>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
            Applied to normal, build-pipeline, and looped native reviews. Orkestrator adds the fixed safety, workflow, and output-schema contract around it.
          </p>
        </div>
        <span
          className={cn(
            "w-fit rounded-full border px-2 py-1 font-mono text-[10px] font-medium uppercase tracking-wider",
            isUsingDefaultReviewInstruction
              ? "border-zinc-700 bg-zinc-900 text-muted-foreground"
              : "border-blue-500/40 bg-blue-500/10 text-blue-300"
          )}
        >
          {isUsingDefaultReviewInstruction ? "Default" : "Custom"}
        </span>
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/50">
        <div className="flex flex-col gap-3 border-b border-zinc-800 bg-zinc-900/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <Label htmlFor="review-instruction" className="text-sm font-medium">
              Review instruction
            </Label>
            <p id="review-instruction-description" className="text-xs text-muted-foreground">
              Describe what reviewers should emphasize. Use <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-[11px] text-zinc-300">{REVIEW_INSTRUCTION_TARGET_BRANCH_TOKEN}</code> for the repository&apos;s PR base branch.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-fit gap-1.5 text-xs"
            onClick={() => setReviewInstruction(DEFAULT_REVIEW_INSTRUCTION)}
            disabled={isUsingDefaultReviewInstruction || isSaving}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset to default
          </Button>
        </div>

        <Textarea
          id="review-instruction"
          aria-describedby={reviewInstructionDescribedBy}
          aria-invalid={reviewInstructionValidationError ? true : undefined}
          value={reviewInstruction}
          onChange={(event) => setReviewInstruction(event.target.value)}
          maxLength={REVIEW_INSTRUCTION_MAX_LENGTH}
          disabled={isSaving}
          spellCheck={false}
          className="h-[50vh] min-h-80 resize-y rounded-none border-0 bg-zinc-950 px-4 py-4 font-mono text-xs leading-5 shadow-none [field-sizing:fixed] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-blue-500 sm:h-[min(60vh,40rem)] sm:min-h-[28rem]"
        />

        <div
          id="review-instruction-status"
          aria-live="polite"
          className="flex items-center justify-between gap-4 border-t border-zinc-800 bg-zinc-900/40 px-4 py-2 font-mono text-[10px] text-muted-foreground"
        >
          <span>{reviewInstruction.includes(REVIEW_INSTRUCTION_TARGET_BRANCH_TOKEN) ? "Target branch token active" : "No dynamic target branch token"}</span>
          <span>
            {reviewInstruction.length.toLocaleString()} / {REVIEW_INSTRUCTION_MAX_LENGTH.toLocaleString()} characters
            {` · ~${reviewInstructionApproxTokens.toLocaleString()} tokens`}
          </span>
        </div>
      </div>

      {reviewInstructionWarningVisible && (
        <p
          id="review-instruction-warning"
          className="flex items-start gap-1.5 text-xs text-amber-300"
        >
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Long review instructions are repeated across review passes and can slow reviews. Keeping them to {REVIEW_INSTRUCTION_RECOMMENDED_LENGTH.toLocaleString()} characters or fewer is recommended; legacy values remain supported.
        </p>
      )}

      {reviewInstructionValidationError && (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {reviewInstructionValidationError}
        </p>
      )}

      <p className="text-xs leading-relaxed text-muted-foreground/70">
        Only this review preference is editable. It cannot remove or override the fixed safety rules, review workflow, or JSON schema. Changes apply to newly started review sessions.
      </p>
    </div>
  );

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
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
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
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {enabledAgentPlatforms.map((platform) => (
            <button
              key={platform}
              type="button"
              onClick={() => setDefaultAgent(platform)}
              className={cn(
                "rounded-lg border-2 p-3 text-left transition-colors",
                defaultAgent === platform
                  ? "border-primary bg-primary/5"
                  : "border-transparent bg-zinc-900 hover:border-zinc-600"
              )}
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <AgentIcon agent={platform} />
                {AGENT_PLATFORM_LABELS[platform]}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
            <Github className="h-4 w-4" />
            GitHub authentication
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Used by containers to clone private repositories and push over HTTPS.
          </p>
        </div>
        <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/50">
          <div className="flex items-center justify-between gap-6 p-4">
            <div className="min-w-0 space-y-1">
              <Label htmlFor="use-host-github-credentials" className="flex items-center gap-2 text-sm font-medium">
                <Terminal className="h-3.5 w-3.5 text-emerald-400" />
                Use host GitHub CLI credentials
              </Label>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Reuses the account signed in with <code className="font-mono text-zinc-300">gh auth login</code> on this computer.
              </p>
            </div>
            <Switch
              id="use-host-github-credentials"
              aria-label="Use host GitHub CLI credentials"
              checked={useHostGitHubCredentials}
              disabled={isSaving}
              onCheckedChange={setUseHostGitHubCredentials}
            />
          </div>

          {useHostGitHubCredentials ? (
            <div className="border-t border-zinc-800 bg-emerald-500/[0.04] px-4 py-3">
              <p className="text-xs text-muted-foreground">
                Host CLI authentication is selected.
                {global.githubTokenConfigured && !clearGithubToken
                  ? " Your stored PAT remains available if you turn this off."
                  : ""}
              </p>
            </div>
          ) : (
            <div className="space-y-3 border-t border-zinc-800 p-4">
              <div className="space-y-1">
                <Label htmlFor="github-token" className="text-sm font-medium">
                  Personal access token
                </Label>
                <p className="text-xs text-muted-foreground">
                  Stored securely by Orkestrator and used instead of the host CLI account.
                </p>
              </div>
              <div className="relative">
                <Input
                  id="github-token"
                  aria-label="GitHub token"
                  type={showGithubToken ? "text" : "password"}
                  value={githubToken}
                  onChange={(e) => {
                    setGithubToken(e.target.value);
                    if (e.target.value) setClearGithubToken(false);
                  }}
                  placeholder={
                    global.githubTokenConfigured && !clearGithubToken
                      ? "Token configured — enter a replacement"
                      : "ghp_..."
                  }
                  className="pr-10 font-mono"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2"
                  onClick={() => setShowGithubToken(!showGithubToken)}
                  aria-label={showGithubToken ? "Hide GitHub token" : "Show GitHub token"}
                >
                  {showGithubToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
              {global.githubTokenConfigured && !clearGithubToken && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setGithubToken("");
                    setClearGithubToken(true);
                  }}
                >
                  Clear stored token
                </Button>
              )}
              {clearGithubToken && (
                <p className="text-xs text-amber-500">
                  The stored GitHub token will be cleared when you save.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Create one at{" "}
                <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  github.com/settings/tokens
                </a>
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Claude Code credentials */}
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">Claude Code Credentials</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Controls whether containerized environments start signed in to Claude Code.
          </p>
        </div>
        <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/50">
          <div className="flex items-center justify-between gap-6 p-4">
            <div className="min-w-0 space-y-1">
              <Label htmlFor="use-host-claude-credentials" className="flex items-center gap-2 text-sm font-medium">
                <Terminal className="h-3.5 w-3.5 text-emerald-400" />
                Use host Claude Code credentials
              </Label>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Copies this computer&apos;s Claude Code login into each container on start. On macOS it is read from the login Keychain.
              </p>
            </div>
            <Switch
              id="use-host-claude-credentials"
              aria-label="Use host Claude Code credentials"
              checked={useHostClaudeCredentials}
              disabled={isSaving}
              onCheckedChange={setUseHostClaudeCredentials}
            />
          </div>

          {useHostClaudeCredentials ? (
            <div className="border-t border-zinc-800 bg-emerald-500/[0.04] px-4 py-3">
              <p className="text-xs text-muted-foreground">
                Containers reuse your host login. The credential is written owner-only and refreshed on every start.
              </p>
            </div>
          ) : (
            <div className="border-t border-zinc-800 bg-amber-500/[0.04] px-4 py-3">
              <p className="text-xs text-muted-foreground">
                Your host token stays on this computer. Run{" "}
                <code className="font-mono text-zinc-300">claude /login</code> inside a container to sign it in.
              </p>
            </div>
          )}
        </div>
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

  const renderPlatforms = () => (
    <div className="max-w-2xl space-y-5">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Bot className="h-4 w-4" />
          Agent platforms
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Enabled systems appear in the toolbar, review picker, and build workflow. Newly enabled binaries are downloaded on the next app launch.
        </p>
      </div>
      <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/40">
        {AGENT_PLATFORMS.map((platform, index) => {
          const checked = enabledAgentPlatforms.includes(platform);
          return (
            <div
              key={platform}
              className={cn(
                "flex items-center justify-between gap-6 px-4 py-3.5",
                index > 0 && "border-t border-zinc-800/80",
              )}
            >
              <Label htmlFor={`platform-${platform}`} className="flex min-w-0 items-center gap-3 text-sm font-medium">
                <span className={cn(
                  "grid size-8 shrink-0 place-items-center rounded-lg border",
                  checked
                    ? "border-cyan-400/30 bg-cyan-500/10 text-cyan-300"
                    : "border-zinc-800 bg-zinc-900 text-zinc-500",
                )}>
                  <AgentIcon agent={platform} className="size-4" />
                </span>
                <span>{AGENT_PLATFORM_LABELS[platform]}</span>
              </Label>
              <Switch
                id={`platform-${platform}`}
                checked={checked}
                onCheckedChange={(next) => {
                  const selected = next
                    ? AGENT_PLATFORMS.filter((candidate) =>
                        candidate === platform || enabledAgentPlatforms.includes(candidate)
                      )
                    : enabledAgentPlatforms.filter((candidate) => candidate !== platform);
                  if (selected.length === 0) {
                    toast.error("Keep at least one agent platform enabled");
                    return;
                  }
                  setEnabledAgentPlatforms(selected);
                  if (!selected.includes(defaultAgent)) setDefaultAgent(selected[0]!);
                }}
              />
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground/70">
        Disabling a platform hides new launch choices; existing sessions and files are kept.
      </p>
    </div>
  );

  const renderModeToggle = (
    mode: "terminal" | "native",
    setMode: (m: "terminal" | "native") => void,
    description: string,
  ) => (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm text-muted-foreground">{description}</p>
      <div className="grid max-w-xs grid-cols-1 gap-3 sm:grid-cols-2">
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
      <div className="grid max-w-md grid-cols-1 gap-3 sm:grid-cols-2">
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

  const renderCursor = () => (
    <div className="max-w-2xl space-y-8">
      <div className="space-y-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Key className="h-4 w-4" />
            Cursor API Key
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Required for Cursor Agent inside Linux containers. A macOS Cursor login is stored in Keychain and cannot be mounted into a container.
          </p>
        </div>
        <div className="relative">
          <Input
            aria-label="Cursor API key"
            type={showCursorApiKey ? "text" : "password"}
            value={cursorApiKey}
            onChange={(event) => {
              setCursorApiKey(event.target.value);
              if (event.target.value) setClearCursorApiKey(false);
            }}
            placeholder={
              global.cursorApiKeyConfigured && !clearCursorApiKey
                ? "API key configured — enter a replacement"
                : "Cursor API key"
            }
            className="pr-10 font-mono"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2"
            onClick={() => setShowCursorApiKey(!showCursorApiKey)}
            aria-label={showCursorApiKey ? "Hide Cursor API key" : "Show Cursor API key"}
          >
            {showCursorApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        </div>
        {global.cursorApiKeyConfigured && !clearCursorApiKey && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setCursorApiKey("");
              setClearCursorApiKey(true);
            }}
          >
            Clear stored Cursor API key
          </Button>
        )}
        {clearCursorApiKey && (
          <p className="text-xs text-amber-500">
            The stored Cursor API key will be cleared when you save.
          </p>
        )}
        {global.cursorApiKeySource === "host-env" && (
          // A key inherited from the backend process environment is forwarded to
          // every new container, but it is not stored here, so neither the field
          // above nor the clear button can revoke it. Say so rather than showing
          // an empty field that implies no key is in play.
          <p className="text-xs text-amber-500">
            No key is stored, but Orkestrator inherited CURSOR_API_KEY from its own environment and
            forwards that key to new containers. Clearing the stored key does not stop it — unset the
            variable and restart Orkestrator. Saving a key here overrides it.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Applied to newly created or recreated containers. Docker receives the key by environment name, and its value is redacted from creation errors.
        </p>
      </div>
    </div>
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
      <div className="space-y-3">
        <div>
          <Label htmlFor="codex-max-concurrent-threads">
            Concurrent subagent limit
          </Label>
          <p
            id="codex-max-concurrent-threads-description"
            className="mt-1 text-xs text-muted-foreground"
          >
            Maximum subagents Codex can keep open at once in a native session. The
            main conversation does not count toward the limit.
          </p>
        </div>
        <Input
          id="codex-max-concurrent-threads"
          type="number"
          min={1}
          max={MAX_CODEX_CONCURRENT_THREADS}
          step={1}
          value={codexMaxConcurrentThreads}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (
              Number.isSafeInteger(value)
              && value >= 1
              && value <= MAX_CODEX_CONCURRENT_THREADS
            ) {
              setCodexMaxConcurrentThreads(value);
            }
          }}
          aria-describedby="codex-max-concurrent-threads-description codex-max-concurrent-threads-restart"
          disabled={isSaving}
          className="max-w-32"
        />
        <p
          id="codex-max-concurrent-threads-restart"
          className="text-xs text-muted-foreground/60"
        >
          Applies when a native Codex bridge next starts.
        </p>
      </div>
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

  const handleCopyGatewayToken = useCallback(async () => {
    try {
      await copyGatewayToken(gatewayToken);
    } catch (error) {
      console.error("[settings] Failed to copy gateway token:", error);
      toast.error("Failed to copy gateway token");
    }
  }, [copyGatewayToken, gatewayToken]);

  const handleCopyWebClientUrl = useCallback(async () => {
    if (!webClientStatus?.url) return;
    try {
      await copyWebClientUrl(webClientStatus.url);
    } catch (error) {
      console.error("[settings] Failed to copy web client URL:", error);
      toast.error("Failed to copy web client URL");
    }
  }, [copyWebClientUrl, webClientStatus?.url]);

  const handleResetTailscaleServe = useCallback(async () => {
    setIsResettingTailscaleServe(true);
    try {
      const status = await backend.resetWebClientServe();
      setWebClientStatus(status);
      setWebClientApplyError(null);
      if (status.error) throw new Error(status.error);
      toast.success("Tailscale Serve reset");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setWebClientStatus((status) => ({
        enabled: status?.enabled ?? webClientEnabled,
        running: status?.running ?? false,
        url: status?.url ?? null,
        error: message,
        resetAvailable: status?.resetAvailable ?? false,
      }));
      toast.error("Failed to reset Tailscale Serve", { description: message });
    } finally {
      setIsResettingTailscaleServe(false);
    }
  }, [webClientEnabled]);

  const renderWebClient = () => {
    const isRemoteClient = window.orkestratorGateway?.enabled === true;
    const hasPendingAccessChange = webClientEnabled !== (global.webClientEnabled ?? true);
    const canResetTailscaleServe = !isRemoteClient
      && !hasPendingAccessChange
      && webClientStatus?.resetAvailable === true;
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
            Connect from orkestrator.dev through a private Tailscale HTTPS address.
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
                  ? "This setting can only be changed in the Electron app."
                  : "Publishes this backend to your tailnet with Tailscale Serve."}
              </p>
            </div>
            <Switch
              id="web-client-enabled"
              aria-label="Allow web access"
              checked={webClientEnabled}
              disabled={isRemoteClient || isSaving}
              onCheckedChange={(enabled) => {
                setWebClientEnabled(enabled);
                setWebClientApplyError(null);
              }}
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
                className="pr-20 font-mono text-xs"
                disabled={isLoadingGatewayToken || !gatewayTokenSettings?.editable || isSaving}
                aria-describedby="gateway-token-description"
                aria-invalid={gatewayTokenValidationError ? true : undefined}
                autoComplete="off"
                spellCheck={false}
              />
              <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setShowGatewayToken((visible) => !visible)}
                  disabled={isLoadingGatewayToken || !gatewayToken}
                  aria-label={showGatewayToken ? "Hide gateway token" : "Show gateway token"}
                >
                  {showGatewayToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => void handleCopyGatewayToken()}
                  disabled={isLoadingGatewayToken || !gatewayToken}
                  aria-label={gatewayTokenCopied ? "Gateway token copied" : "Copy gateway token"}
                  title={gatewayTokenCopied ? "Copied" : "Copy token"}
                >
                  {gatewayTokenCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
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

              {webClientStatus?.running && webClientStatus.url && !hasPendingAccessChange && (
                <div className="flex min-w-0 items-center gap-1">
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
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                    onClick={() => void handleCopyWebClientUrl()}
                    aria-label={webClientUrlCopied ? "Web client URL copied" : "Copy web client URL"}
                    title={webClientUrlCopied ? "Copied" : "Copy web client URL"}
                  >
                    {webClientUrlCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              )}
            </div>

            {hasPendingAccessChange && (
              <p className="mt-2 text-xs text-amber-400/90">
                Save changes to {webClientEnabled ? "start" : "stop"} web access.
              </p>
            )}
            {!hasPendingAccessChange && webClientStatus?.error && (
              <div className="mt-2">
                <p className="flex items-start gap-1.5 text-xs text-amber-400/90">
                  <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                  {webClientStatus.error}
                </p>
                {canResetTailscaleServe && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-3 h-7 gap-1.5 text-xs"
                        disabled={isResettingTailscaleServe}
                      >
                        {isResettingTailscaleServe
                          ? <Loader2 className="h-3 w-3 animate-spin" />
                          : <RefreshCw className="h-3 w-3" />}
                        Reset Tailscale Serve
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent
                      className={Z_FULLSCREEN_DIALOG}
                      overlayClassName={Z_FULLSCREEN_DIALOG}
                    >
                      <AlertDialogHeader>
                        <AlertDialogTitle>Reset Tailscale Serve?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This removes the existing HTTPS listener on port 443, then publishes Orkestrator again. Any other service using that listener will be disconnected.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void handleResetTailscaleServe()}>
                          Reset Tailscale Serve
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            )}
          </div>
        </div>

        <p className="text-xs leading-relaxed text-muted-foreground/70">
          When enabled, enter the HTTPS address shown above and this gateway token at www.orkestrator.dev. Both devices must be on the same tailnet.
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
    platforms: renderPlatforms,
    review: renderReview,
    claude: renderClaude,
    cursor: renderCursor,
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
        <Button onClick={handleSave} disabled={!hasChanges || isSaving || saveSuccess || domainErrors.length > 0 || !!colorError || !!gatewayTokenValidationError || !!reviewInstructionValidationError}>
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
