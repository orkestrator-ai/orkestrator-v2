import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Check, Loader2 } from "lucide-react";
import { useConfigStore } from "@/stores";
import * as backend from "@/lib/backend";
import { getGatewayTokenValidationError } from "@/lib/gateway-token";
import { getReviewInstructionValidationError } from "@orkestrator/protocol/review-instruction";
import { useTimedCopyFeedback } from "@/hooks";
import { DEFAULT_REVIEW_INSTRUCTION } from "@/prompts";
import type {
  DomainTestResult,
  GatewayTokenSettings,
  GlobalConfig,
  PreferredEditor,
  TerminalAppearance,
  WebClientStatus,
} from "@/types";
import {
  DEFAULT_TERMINAL_APPEARANCE,
  DEFAULT_TERMINAL_SCROLLBACK,
  isValidHexColor,
} from "@/constants/terminal";
import { type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  normalizeAgentSettings,
  type AgentSettingsTier,
} from "@orkestrator/protocol/agent-settings";
import { normalizeOpenCodeModelProviders } from "@orkestrator/protocol/native-agent";
import {
  MAX_DEBUG_LOG_RETENTION_DAYS,
  MIN_DEBUG_LOG_RETENTION_DAYS,
  isValidDebugLogRetentionDays,
  normalizeDebugLogRetentionDays,
} from "@orkestrator/protocol/debug-logging";
import { GlobalSettingsSections } from "./GlobalSettings.sections";

// Domain validation regex
const DOMAIN_REGEX = /^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

const DEFAULT_CODEX_MAX_CONCURRENT_THREADS = 5;
const MAX_SSH_AGENT_SOCKET_PATH_CHARS = 4_096;

export function getSshAgentSocketPathValidationError(value: string): string | null {
  const candidate = value.trim();
  if (!candidate) return null;
  if (candidate.length > MAX_SSH_AGENT_SOCKET_PATH_CHARS) {
    return "SSH agent socket path is too long.";
  }
  if (candidate.includes("\0") || !candidate.startsWith("/")) {
    return "SSH agent socket path must be an absolute path.";
  }
  return null;
}

function getSavedReviewInstruction(value: unknown): string {
  return typeof value === "string" && getReviewInstructionValidationError(value) === null
    ? value
    : DEFAULT_REVIEW_INSTRUCTION;
}

/**
 * Exactly the persisted values this form syncs itself from.
 *
 * The config store replaces `config.global` on every write, including writes
 * this form does not own — the Defaults pane's favourite star and drag-reorder
 * persist `favoriteModels` optimistically while the user is still editing.
 * Re-syncing on object identity alone would discard those in-progress edits
 * with no indication and leave Save Changes disabled, so the sync is keyed on
 * the values instead. Any field the sync effect below reads belongs here.
 */
export function globalFormSignature(global: GlobalConfig): string {
  return JSON.stringify([
    global.containerResources.cpuCores,
    global.containerResources.memoryGb,
    global.envFilePatterns,
    global.useHostGitHubCredentials ?? true,
    global.sshAgentSocketPath ?? "",
    global.useHostClaudeCredentials ?? true,
    global.allowedDomains ?? [],
    global.preferredEditor ?? "vscode",
    global.enabledAgentPlatforms ?? ["claude", "codex", "opencode"],
    normalizeOpenCodeModelProviders(global.openCodeModelProviders),
    global.codexMaxConcurrentThreads ?? DEFAULT_CODEX_MAX_CONCURRENT_THREADS,
    global.terminalAppearance?.fontFamily ?? "",
    global.terminalAppearance?.fontSize ?? 0,
    global.terminalAppearance?.backgroundColor ?? "",
    global.terminalScrollback ?? DEFAULT_TERMINAL_SCROLLBACK,
    global.experimentalCodexRawEventLogging ?? true,
    global.debugLogging ?? false,
    normalizeDebugLogRetentionDays(global.debugLogRetentionDays),
    global.webClientEnabled ?? true,
    getSavedReviewInstruction(global.reviewInstruction),
    // Canonical shape, so an edit that only reorders keys is not a change.
    normalizeAgentSettings(global.agentSettings),
  ]);
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
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [clearAnthropicApiKey, setClearAnthropicApiKey] = useState(false);
  const [cursorApiKey, setCursorApiKey] = useState("");
  const [clearCursorApiKey, setClearCursorApiKey] = useState(false);
  const [useHostGitHubCredentials, setUseHostGitHubCredentials] = useState(
    global.useHostGitHubCredentials ?? true,
  );
  const [sshAgentSocketPath, setSshAgentSocketPath] = useState(global.sshAgentSocketPath ?? "");
  const [useHostClaudeCredentials, setUseHostClaudeCredentials] = useState(
    global.useHostClaudeCredentials ?? true,
  );
  const [githubToken, setGithubToken] = useState("");
  const [clearGithubToken, setClearGithubToken] = useState(false);
  const [allowedDomains, setAllowedDomains] = useState((global.allowedDomains || []).join("\n"));
  const [preferredEditor, setPreferredEditor] = useState<PreferredEditor>(
    global.preferredEditor || "vscode",
  );
  // One block for every agent setting. Each pane edits a slice of it and the
  // whole thing is written on save, which is what makes the three tiers
  // identical in shape.
  const [agentSettings, setAgentSettings] = useState<AgentSettingsTier>(() =>
    normalizeAgentSettings(global.agentSettings),
  );
  const [enabledAgentPlatforms, setEnabledAgentPlatforms] = useState<AgentPlatform[]>(
    global.enabledAgentPlatforms ?? ["claude", "codex", "opencode"],
  );
  const [openCodeModelProviders, setOpenCodeModelProviders] = useState<string[]>(() =>
    normalizeOpenCodeModelProviders(global.openCodeModelProviders),
  );
  const [openCodeProviderDraft, setOpenCodeProviderDraft] = useState("");
  const [codexMaxConcurrentThreads, setCodexMaxConcurrentThreads] = useState(
    global.codexMaxConcurrentThreads ?? DEFAULT_CODEX_MAX_CONCURRENT_THREADS,
  );
  const [terminalFontFamily, setTerminalFontFamily] = useState(
    global.terminalAppearance?.fontFamily || DEFAULT_TERMINAL_APPEARANCE.fontFamily,
  );
  const [terminalFontSize, setTerminalFontSize] = useState(
    global.terminalAppearance?.fontSize || DEFAULT_TERMINAL_APPEARANCE.fontSize,
  );
  const [terminalBackgroundColor, setTerminalBackgroundColor] = useState(
    global.terminalAppearance?.backgroundColor || DEFAULT_TERMINAL_APPEARANCE.backgroundColor,
  );
  const [terminalScrollback, setTerminalScrollback] = useState(
    typeof global.terminalScrollback === "number"
      ? global.terminalScrollback
      : DEFAULT_TERMINAL_SCROLLBACK,
  );
  const [experimentalCodexRawEventLogging, setExperimentalCodexRawEventLogging] = useState(
    global.experimentalCodexRawEventLogging ?? true,
  );
  const [debugLogging, setDebugLogging] = useState(global.debugLogging ?? false);
  const [debugLogRetentionDays, setDebugLogRetentionDays] = useState(
    normalizeDebugLogRetentionDays(global.debugLogRetentionDays),
  );
  const [webClientEnabled, setWebClientEnabled] = useState(global.webClientEnabled ?? true);
  const [reviewInstruction, setReviewInstruction] = useState(
    getSavedReviewInstruction(global.reviewInstruction),
  );
  const [webClientStatus, setWebClientStatus] = useState<WebClientStatus | null>(null);
  const [webClientApplyError, setWebClientApplyError] = useState<string | null>(null);
  const [gatewayTokenSettings, setGatewayTokenSettings] = useState<GatewayTokenSettings | null>(
    null,
  );
  const [gatewayToken, setGatewayToken] = useState("");
  const [savedGatewayToken, setSavedGatewayToken] = useState("");
  const [gatewayTokenLoadError, setGatewayTokenLoadError] = useState<string | null>(null);
  const [isLoadingWebClientStatus, setIsLoadingWebClientStatus] = useState(false);
  const [isLoadingGatewayToken, setIsLoadingGatewayToken] = useState(false);
  const [logDirectory, setLogDirectory] = useState<string | null>(null);
  const [logStorageStats, setLogStorageStats] = useState<backend.LogStorageStats | null>(null);
  const [isLoadingLogStorage, setIsLoadingLogStorage] = useState(false);
  const [isCleaningLogs, setIsCleaningLogs] = useState(false);
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
  const logStorageRequestRef = useRef(0);
  // The last `global` this form synced itself from, as a value rather than an
  // object identity. `null` until the first sync so a fresh mount always runs.
  const syncedGlobalSignatureRef = useRef<string | null>(null);
  const pendingGitHubCredentialEditRef = useRef<{
    token: string;
    clear: boolean;
  } | null>(null);
  const pendingCursorCredentialEditRef = useRef<{
    apiKey: string;
    clear: boolean;
  } | null>(null);
  const pendingAnthropicCredentialEditRef = useRef<{
    apiKey: string;
    clear: boolean;
  } | null>(null);

  // Sync local state when config changes in the store
  useEffect(() => {
    // A store write that changes none of the values this form edits must not
    // reach the setters below: they would discard whatever the user has typed
    // or selected but not yet saved. The Defaults pane's favourite star is the
    // routine case — it persists `favoriteModels` from inside this very form.
    const signature = globalFormSignature(global);
    if (syncedGlobalSignatureRef.current === signature) return;
    syncedGlobalSignatureRef.current = signature;
    setCpuCores(global.containerResources.cpuCores);
    setMemoryGb(global.containerResources.memoryGb);
    setEnvPatterns(global.envFilePatterns.join(", "));
    setAnthropicApiKey(pendingAnthropicCredentialEditRef.current?.apiKey ?? "");
    setClearAnthropicApiKey(pendingAnthropicCredentialEditRef.current?.clear ?? false);
    setCursorApiKey(pendingCursorCredentialEditRef.current?.apiKey ?? "");
    setClearCursorApiKey(pendingCursorCredentialEditRef.current?.clear ?? false);
    setUseHostGitHubCredentials(global.useHostGitHubCredentials ?? true);
    setSshAgentSocketPath(global.sshAgentSocketPath ?? "");
    setUseHostClaudeCredentials(global.useHostClaudeCredentials ?? true);
    setGithubToken(pendingGitHubCredentialEditRef.current?.token ?? "");
    setClearGithubToken(pendingGitHubCredentialEditRef.current?.clear ?? false);
    setAllowedDomains((global.allowedDomains || []).join("\n"));
    setPreferredEditor(global.preferredEditor || "vscode");
    setEnabledAgentPlatforms(global.enabledAgentPlatforms ?? ["claude", "codex", "opencode"]);
    setAgentSettings(normalizeAgentSettings(global.agentSettings));
    setOpenCodeModelProviders(normalizeOpenCodeModelProviders(global.openCodeModelProviders));
    setCodexMaxConcurrentThreads(
      global.codexMaxConcurrentThreads ?? DEFAULT_CODEX_MAX_CONCURRENT_THREADS,
    );
    const appearance = global.terminalAppearance || DEFAULT_TERMINAL_APPEARANCE;
    setTerminalFontFamily(appearance.fontFamily);
    setTerminalFontSize(appearance.fontSize);
    setTerminalBackgroundColor(appearance.backgroundColor);
    setTerminalScrollback(global.terminalScrollback ?? DEFAULT_TERMINAL_SCROLLBACK);
    setExperimentalCodexRawEventLogging(global.experimentalCodexRawEventLogging ?? true);
    setDebugLogging(global.debugLogging ?? false);
    setDebugLogRetentionDays(normalizeDebugLogRetentionDays(global.debugLogRetentionDays));
    setWebClientEnabled(global.webClientEnabled ?? true);
    setReviewInstruction(getSavedReviewInstruction(global.reviewInstruction));
  }, [global]);

  const refreshWebClientStatus = useCallback(async () => {
    const requestId = ++webClientStatusRequestRef.current;
    setIsLoadingWebClientStatus(true);
    setIsLoadingGatewayToken(true);
    setGatewayTokenLoadError(null);

    const statusRequest = backend
      .getWebClientStatus()
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

    const tokenRequest = backend
      .getGatewayTokenSettings()
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

  // `get_log_storage_stats` stats every file under the log tree, so it is kept
  // off the mount path of unrelated sections. The directory itself is a path
  // join on the backend and stays cheap enough to fetch eagerly. Walks and
  // cleanups share one generation so a slower earlier request cannot replace
  // newer stats or clear the spinner while a later walk is still in flight.
  const refreshLogStorage = useCallback(async () => {
    const requestId = ++logStorageRequestRef.current;
    setIsLoadingLogStorage(true);
    const [directory, stats] = await Promise.allSettled([
      backend.getLogDirectory(),
      backend.getLogStorageStats(),
    ]);
    if (requestId !== logStorageRequestRef.current) return;
    if (directory.status === "fulfilled") setLogDirectory(directory.value);
    setLogStorageStats(stats.status === "fulfilled" ? stats.value : null);
    setIsLoadingLogStorage(false);
  }, []);

  useEffect(() => {
    backend
      .getLogDirectory()
      .then(setLogDirectory)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (activeSection === "debug") void refreshLogStorage();
    return () => {
      logStorageRequestRef.current += 1;
    };
  }, [activeSection, refreshLogStorage]);

  const handleCleanupLogs = useCallback(async () => {
    const requestId = ++logStorageRequestRef.current;
    setIsCleaningLogs(true);
    setIsLoadingLogStorage(false);
    try {
      const stats = await backend.cleanupLogs();
      if (requestId !== logStorageRequestRef.current) return;
      setLogStorageStats(stats);
      toast.success("Logs cleaned up");
    } catch (error) {
      if (requestId !== logStorageRequestRef.current) return;
      toast.error("Failed to clean up logs", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setIsCleaningLogs(false);
    }
  }, []);

  // Check for changes
  useEffect(() => {
    const terminalAppearance = global.terminalAppearance || DEFAULT_TERMINAL_APPEARANCE;
    const changed =
      cpuCores !== global.containerResources.cpuCores ||
      memoryGb !== global.containerResources.memoryGb ||
      envPatterns !== global.envFilePatterns.join(", ") ||
      anthropicApiKey.trim().length > 0 ||
      clearAnthropicApiKey ||
      cursorApiKey.trim().length > 0 ||
      clearCursorApiKey ||
      useHostGitHubCredentials !== (global.useHostGitHubCredentials ?? true) ||
      sshAgentSocketPath !== (global.sshAgentSocketPath ?? "") ||
      useHostClaudeCredentials !== (global.useHostClaudeCredentials ?? true) ||
      githubToken.trim().length > 0 ||
      clearGithubToken ||
      githubCredentialPropagationPending ||
      allowedDomains !== (global.allowedDomains || []).join("\n") ||
      preferredEditor !== (global.preferredEditor || "vscode") ||
      JSON.stringify(enabledAgentPlatforms) !==
        JSON.stringify(global.enabledAgentPlatforms ?? ["claude", "codex", "opencode"]) ||
      JSON.stringify(agentSettings) !==
        JSON.stringify(normalizeAgentSettings(global.agentSettings)) ||
      JSON.stringify(openCodeModelProviders) !==
        JSON.stringify(normalizeOpenCodeModelProviders(global.openCodeModelProviders)) ||
      codexMaxConcurrentThreads !==
        (global.codexMaxConcurrentThreads ?? DEFAULT_CODEX_MAX_CONCURRENT_THREADS) ||
      terminalFontFamily !== terminalAppearance.fontFamily ||
      terminalFontSize !== terminalAppearance.fontSize ||
      terminalBackgroundColor !== terminalAppearance.backgroundColor ||
      terminalScrollback !== (global.terminalScrollback ?? DEFAULT_TERMINAL_SCROLLBACK) ||
      experimentalCodexRawEventLogging !== (global.experimentalCodexRawEventLogging ?? true) ||
      debugLogging !== (global.debugLogging ?? false) ||
      debugLogRetentionDays !== normalizeDebugLogRetentionDays(global.debugLogRetentionDays) ||
      webClientEnabled !== (global.webClientEnabled ?? true) ||
      reviewInstruction !== getSavedReviewInstruction(global.reviewInstruction) ||
      webClientApplyError !== null ||
      gatewayToken !== savedGatewayToken;
    setHasChanges(changed);
    if (changed) {
      setSaveSuccess(false);
    }
  }, [
    cpuCores,
    memoryGb,
    envPatterns,
    anthropicApiKey,
    clearAnthropicApiKey,
    cursorApiKey,
    clearCursorApiKey,
    useHostGitHubCredentials,
    sshAgentSocketPath,
    useHostClaudeCredentials,
    githubToken,
    clearGithubToken,
    githubCredentialPropagationPending,
    allowedDomains,
    preferredEditor,
    enabledAgentPlatforms,
    agentSettings,
    openCodeModelProviders,
    codexMaxConcurrentThreads,
    terminalFontFamily,
    terminalFontSize,
    terminalBackgroundColor,
    terminalScrollback,
    experimentalCodexRawEventLogging,
    debugLogging,
    debugLogRetentionDays,
    webClientEnabled,
    reviewInstruction,
    webClientApplyError,
    gatewayToken,
    savedGatewayToken,
    global,
  ]);

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
      const patterns = [
        ...new Set(
          envPatterns
            .split(",")
            .map((p) => p.trim())
            .filter((p) => p.length > 0),
        ),
      ];

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
        useHostGitHubCredentials: boolean;
        sshAgentSocketPath?: string;
        useHostClaudeCredentials: boolean;
        preferredEditor?: PreferredEditor;
        enabledAgentPlatforms: AgentPlatform[];
        favoriteModels: Array<{ platform: AgentPlatform; modelId: string }>;
        agentSettings: AgentSettingsTier;
        openCodeModelProviders: string[];
        codexMaxConcurrentThreads: number;
        terminalAppearance: TerminalAppearance;
        terminalScrollback: number;
        experimentalCodexRawEventLogging: boolean;
        debugLogging: boolean;
        debugLogRetentionDays: number;
        webClientEnabled: boolean;
        reviewInstruction?: string;
      } = {
        containerResources: { cpuCores, memoryGb },
        envFilePatterns: patterns,
        allowedDomains: domains,
        useHostGitHubCredentials,
        ...(sshAgentSocketPath.trim() ? { sshAgentSocketPath: sshAgentSocketPath.trim() } : {}),
        useHostClaudeCredentials,
        preferredEditor,
        enabledAgentPlatforms,
        favoriteModels: global.favoriteModels ?? [],
        agentSettings: normalizeAgentSettings(agentSettings),
        openCodeModelProviders: normalizeOpenCodeModelProviders(openCodeModelProviders),
        codexMaxConcurrentThreads,
        terminalAppearance: {
          fontFamily: terminalFontFamily,
          fontSize: terminalFontSize,
          backgroundColor: terminalBackgroundColor,
        },
        terminalScrollback,
        experimentalCodexRawEventLogging,
        debugLogging,
        debugLogRetentionDays,
        webClientEnabled,
        // `update_global_config` replaces the stored global wholesale, so this
        // has to be sent from every section's save, not only the Defaults tab.
      };

      if (reviewInstruction !== DEFAULT_REVIEW_INSTRUCTION) {
        newGlobal.reviewInstruction = reviewInstruction;
      }

      let newConfig = await backend.updateGlobalConfig(newGlobal);
      const nextAnthropicApiKey = anthropicApiKey.trim();
      const anthropicApiKeyChanged = clearAnthropicApiKey || nextAnthropicApiKey.length > 0;
      const nextCursorApiKey = cursorApiKey.trim();
      const cursorApiKeyChanged = clearCursorApiKey || nextCursorApiKey.length > 0;
      const nextGitHubToken = githubToken.trim();
      const githubCredentialSourceChanged =
        useHostGitHubCredentials !== (global.useHostGitHubCredentials ?? true);
      const githubTokenChanged = clearGithubToken || nextGitHubToken.length > 0;
      const githubCredentialChanged = githubCredentialSourceChanged || githubTokenChanged;
      if (anthropicApiKeyChanged) {
        pendingAnthropicCredentialEditRef.current = {
          apiKey: anthropicApiKey,
          clear: clearAnthropicApiKey,
        };
      }
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
      if (anthropicApiKeyChanged) {
        newConfig = await backend.setAnthropicApiKey(
          clearAnthropicApiKey ? null : nextAnthropicApiKey,
        );
        pendingAnthropicCredentialEditRef.current = null;
        setConfig(newConfig);
      }
      if (cursorApiKeyChanged) {
        newConfig = await backend.setCursorApiKey(clearCursorApiKey ? null : nextCursorApiKey);
        pendingCursorCredentialEditRef.current = null;
        setConfig(newConfig);
      }
      if (githubTokenChanged) {
        newConfig = await backend.setGitHubToken(clearGithubToken ? null : nextGitHubToken);
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
              ]
                .filter(Boolean)
                .join(" "),
            });
          } else {
            setGithubCredentialPropagationPending(false);
          }
          if (propagateResult.updated.length > 0 && propagateResult.failed.length === 0) {
            toast.success(
              `Updated GitHub credentials in ${propagateResult.updated.length} container(s)`,
            );
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

      setAnthropicApiKey("");
      setClearAnthropicApiKey(false);
      pendingAnthropicCredentialEditRef.current = null;
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
        setTimeout(() => {
          onSaveSuccess?.();
        }, 500);
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
    setAnthropicApiKey("");
    setClearAnthropicApiKey(false);
    pendingAnthropicCredentialEditRef.current = null;
    setCursorApiKey("");
    setClearCursorApiKey(false);
    pendingCursorCredentialEditRef.current = null;
    setUseHostGitHubCredentials(global.useHostGitHubCredentials ?? true);
    setSshAgentSocketPath(global.sshAgentSocketPath ?? "");
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
    setAgentSettings(normalizeAgentSettings(global.agentSettings));
    setOpenCodeModelProviders(normalizeOpenCodeModelProviders(global.openCodeModelProviders));
    setOpenCodeProviderDraft("");
    setCodexMaxConcurrentThreads(
      global.codexMaxConcurrentThreads ?? DEFAULT_CODEX_MAX_CONCURRENT_THREADS,
    );
    const appearance = global.terminalAppearance || DEFAULT_TERMINAL_APPEARANCE;
    setTerminalFontFamily(appearance.fontFamily);
    setTerminalFontSize(appearance.fontSize);
    setTerminalBackgroundColor(appearance.backgroundColor);
    setTerminalScrollback(global.terminalScrollback ?? DEFAULT_TERMINAL_SCROLLBACK);
    setExperimentalCodexRawEventLogging(global.experimentalCodexRawEventLogging ?? true);
    setDebugLogging(global.debugLogging ?? false);
    setDebugLogRetentionDays(normalizeDebugLogRetentionDays(global.debugLogRetentionDays));
    setWebClientEnabled(global.webClientEnabled ?? true);
    setReviewInstruction(getSavedReviewInstruction(global.reviewInstruction));
    setWebClientApplyError(null);
    setGatewayToken(savedGatewayToken);
    setDomainErrors([]);
    setColorError(null);
    setTestResults(null);
  };

  const gatewayTokenValidationError = gatewayTokenSettings?.editable
    ? getGatewayTokenValidationError(gatewayToken)
    : null;
  const reviewInstructionValidationError = getReviewInstructionValidationError(reviewInstruction);
  const sshAgentSocketPathValidationError =
    getSshAgentSocketPathValidationError(sshAgentSocketPath);

  const sectionSettings = {
    global,
    cpuCores,
    setCpuCores,
    memoryGb,
    setMemoryGb,
    envPatterns,
    setEnvPatterns,
    anthropicApiKey,
    setAnthropicApiKey,
    clearAnthropicApiKey,
    setClearAnthropicApiKey,
    cursorApiKey,
    setCursorApiKey,
    clearCursorApiKey,
    setClearCursorApiKey,
    useHostGitHubCredentials,
    setUseHostGitHubCredentials,
    sshAgentSocketPath,
    setSshAgentSocketPath,
    sshAgentSocketPathValidationError,
    useHostClaudeCredentials,
    setUseHostClaudeCredentials,
    githubToken,
    setGithubToken,
    clearGithubToken,
    setClearGithubToken,
    allowedDomains,
    setAllowedDomains,
    preferredEditor,
    setPreferredEditor,
    agentSettings,
    setAgentSettings,
    enabledAgentPlatforms,
    setEnabledAgentPlatforms,
    openCodeModelProviders,
    setOpenCodeModelProviders,
    openCodeProviderDraft,
    setOpenCodeProviderDraft,
    codexMaxConcurrentThreads,
    setCodexMaxConcurrentThreads,
    terminalFontFamily,
    setTerminalFontFamily,
    terminalFontSize,
    setTerminalFontSize,
    terminalBackgroundColor,
    setTerminalBackgroundColor,
    terminalScrollback,
    setTerminalScrollback,
    experimentalCodexRawEventLogging,
    setExperimentalCodexRawEventLogging,
    debugLogging,
    setDebugLogging,
    debugLogRetentionDays,
    setDebugLogRetentionDays,
    webClientEnabled,
    setWebClientEnabled,
    reviewInstruction,
    setReviewInstruction,
    webClientStatus,
    setWebClientStatus,
    webClientApplyError,
    setWebClientApplyError,
    gatewayTokenSettings,
    setGatewayTokenSettings,
    gatewayToken,
    setGatewayToken,
    savedGatewayToken,
    setSavedGatewayToken,
    gatewayTokenLoadError,
    setGatewayTokenLoadError,
    isLoadingWebClientStatus,
    setIsLoadingWebClientStatus,
    isLoadingGatewayToken,
    setIsLoadingGatewayToken,
    logDirectory,
    setLogDirectory,
    logStorageStats,
    isLoadingLogStorage,
    isCleaningLogs,
    refreshLogStorage,
    handleCleanupLogs,
    showApiKey,
    setShowApiKey,
    showCursorApiKey,
    setShowCursorApiKey,
    showGithubToken,
    setShowGithubToken,
    showGatewayToken,
    setShowGatewayToken,
    gatewayTokenCopied,
    copyGatewayToken,
    webClientUrlCopied,
    copyWebClientUrl,
    isResettingTailscaleServe,
    setIsResettingTailscaleServe,
    githubCredentialPropagationPending,
    setGithubCredentialPropagationPending,
    domainErrors,
    setDomainErrors,
    colorError,
    setColorError,
    isTesting,
    setIsTesting,
    testResults,
    setTestResults,
    isSaving,
    handleDomainsChange,
    handleBackgroundColorChange,
    handleTestDomains,
  };

  // The Save button is shared by every section, so a validation failure in one
  // section blocks saving in all of them. Each blocker carries the section that
  // owns it so the save bar can name the reason when the user is looking
  // somewhere else, rather than leaving the disabled button unexplained.
  const saveBlocker = useMemo(() => {
    const blockers: Array<{ section: string; message: string }> = [];
    if (domainErrors.length > 0) {
      blockers.push({
        section: "network",
        message: "Fix the allowed-domain errors in Network before saving.",
      });
    }
    if (colorError) blockers.push({ section: "terminal", message: colorError });
    if (!isValidDebugLogRetentionDays(debugLogRetentionDays)) {
      blockers.push({
        section: "debug",
        message: `Log retention in Debug must be a whole number from ${MIN_DEBUG_LOG_RETENTION_DAYS} to ${MAX_DEBUG_LOG_RETENTION_DAYS} days.`,
      });
    }
    if (gatewayTokenValidationError) {
      blockers.push({ section: "web-client", message: gatewayTokenValidationError });
    }
    if (reviewInstructionValidationError) {
      blockers.push({ section: "review", message: reviewInstructionValidationError });
    }
    if (sshAgentSocketPathValidationError) {
      blockers.push({ section: "general", message: sshAgentSocketPathValidationError });
    }
    return blockers[0] ?? null;
  }, [
    domainErrors,
    colorError,
    debugLogRetentionDays,
    gatewayTokenValidationError,
    reviewInstructionValidationError,
    sshAgentSocketPathValidationError,
  ]);
  // The owning section already renders its own inline message; repeating it
  // here would show the same error twice.
  const saveBlockedReason =
    saveBlocker && saveBlocker.section !== activeSection ? saveBlocker.message : null;
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1">
        <GlobalSettingsSections activeSection={activeSection} settings={sectionSettings} />
      </div>

      {/* Sticky save bar */}
      <div className="flex items-center justify-end gap-3 pt-6 pb-2 border-t border-zinc-800/50 mt-8">
        {saveBlockedReason && (
          <p role="alert" className="text-xs text-destructive text-right">
            {saveBlockedReason}
          </p>
        )}
        <Button variant="outline" onClick={handleReset} disabled={!hasChanges}>
          Reset
        </Button>
        <Button
          onClick={handleSave}
          disabled={!hasChanges || isSaving || saveSuccess || saveBlocker !== null}
        >
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
