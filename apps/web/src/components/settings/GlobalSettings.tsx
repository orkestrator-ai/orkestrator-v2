import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import { useConfigStore } from "@/stores";
import * as backend from "@/lib/backend";
import { getGatewayTokenValidationError } from "@/lib/gateway-token";
import { getReviewInstructionValidationError } from "@orkestrator/protocol/review-instruction";
import { DEFAULT_COORDINATOR_PROVIDER_TIER } from "@orkestrator/protocol/coordinator";
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
import {
  DEFAULT_TERMINAL_HISTORY_ENABLED,
  DEFAULT_TERMINAL_HISTORY_GLOBAL_RETENTION_MB,
  DEFAULT_TERMINAL_HISTORY_RETENTION_DAYS,
  DEFAULT_TERMINAL_HISTORY_RETENTION_MB,
  MAX_TERMINAL_HISTORY_GLOBAL_RETENTION_MB,
  MAX_TERMINAL_HISTORY_RETENTION_DAYS,
  MAX_TERMINAL_HISTORY_RETENTION_MB,
  MIN_TERMINAL_HISTORY_GLOBAL_RETENTION_MB,
  MIN_TERMINAL_HISTORY_RETENTION_DAYS,
  MIN_TERMINAL_HISTORY_RETENTION_MB,
} from "@orkestrator/protocol/terminal-history";
import {
  MAX_SSH_AGENT_SOCKET_PATH_CHARS,
  SSH_AGENT_SOCKET_PATH_ERROR_MESSAGES,
} from "@orkestrator/protocol/ssh-agent-socket";
import { GlobalSettingsSections } from "./GlobalSettings.sections";

// Long enough that a slider drag or a fast typist produces one write, short
// enough that releasing a control feels like it saved immediately.
const AUTO_SAVE_DEBOUNCE_MS = 400;

// Domain validation regex
const DOMAIN_REGEX = /^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

const DEFAULT_CODEX_MAX_CONCURRENT_THREADS = 5;
export function getSshAgentSocketPathValidationError(value: string): string | null {
  const candidate = value.trim();
  if (!candidate) return null;
  if (candidate.length > MAX_SSH_AGENT_SOCKET_PATH_CHARS) {
    return SSH_AGENT_SOCKET_PATH_ERROR_MESSAGES.tooLong;
  }
  if (candidate.includes("\0")) {
    return SSH_AGENT_SOCKET_PATH_ERROR_MESSAGES.containsNull;
  }
  if (!candidate.startsWith("/")) {
    return SSH_AGENT_SOCKET_PATH_ERROR_MESSAGES.notAbsolute;
  }
  return null;
}

export function sshAgentSocketPathForSave(value: string): string | undefined {
  return value.trim() || undefined;
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
    global.coordinatorProviderTiers ?? DEFAULT_COORDINATOR_PROVIDER_TIER,
    normalizeOpenCodeModelProviders(global.openCodeModelProviders),
    global.codexMaxConcurrentThreads ?? DEFAULT_CODEX_MAX_CONCURRENT_THREADS,
    global.terminalAppearance?.fontFamily ?? "",
    global.terminalAppearance?.fontSize ?? 0,
    global.terminalAppearance?.backgroundColor ?? "",
    global.terminalScrollback ?? DEFAULT_TERMINAL_SCROLLBACK,
    global.terminalHistoryEnabled ?? DEFAULT_TERMINAL_HISTORY_ENABLED,
    global.terminalHistoryRetentionMb ?? DEFAULT_TERMINAL_HISTORY_RETENTION_MB,
    global.terminalHistoryGlobalRetentionMb ?? DEFAULT_TERMINAL_HISTORY_GLOBAL_RETENTION_MB,
    global.terminalHistoryRetentionDays ?? DEFAULT_TERMINAL_HISTORY_RETENTION_DAYS,
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
}

export function GlobalSettings({ activeSection }: GlobalSettingsProps) {
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
  const [openCodeZenApiKey, setOpenCodeZenApiKey] = useState("");
  const [clearOpenCodeZenApiKey, setClearOpenCodeZenApiKey] = useState(false);
  // Bumped after a credential save so the plan-usage card on that platform
  // remounts and re-reads immediately instead of waiting for the cache TTL.
  const [planUsageRefreshToken, setPlanUsageRefreshToken] = useState(0);
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
  const [coordinatorProviderTiers, setCoordinatorProviderTiers] = useState<
    "enforced" | "provider-configured" | "advisory"
  >(global.coordinatorProviderTiers ?? DEFAULT_COORDINATOR_PROVIDER_TIER);
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
  const [terminalHistoryRetentionMb, setTerminalHistoryRetentionMb] = useState(
    global.terminalHistoryRetentionMb ?? DEFAULT_TERMINAL_HISTORY_RETENTION_MB,
  );
  const [terminalHistoryEnabled, setTerminalHistoryEnabled] = useState(
    global.terminalHistoryEnabled ?? DEFAULT_TERMINAL_HISTORY_ENABLED,
  );
  const [terminalHistoryGlobalRetentionMb, setTerminalHistoryGlobalRetentionMb] = useState(
    global.terminalHistoryGlobalRetentionMb ?? DEFAULT_TERMINAL_HISTORY_GLOBAL_RETENTION_MB,
  );
  const [terminalHistoryRetentionDays, setTerminalHistoryRetentionDays] = useState(
    global.terminalHistoryRetentionDays ?? DEFAULT_TERMINAL_HISTORY_RETENTION_DAYS,
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
  const [showOpenCodeZenApiKey, setShowOpenCodeZenApiKey] = useState(false);
  const [showGithubToken, setShowGithubToken] = useState(false);
  const [showGatewayToken, setShowGatewayToken] = useState(false);
  const { copied: gatewayTokenCopied, copy: copyGatewayToken } = useTimedCopyFeedback();
  const { copied: webClientUrlCopied, copy: copyWebClientUrl } = useTimedCopyFeedback();
  const [isResettingTailscaleServe, setIsResettingTailscaleServe] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [coreHasChanges, setCoreHasChanges] = useState(false);
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
  const pendingOpenCodeZenCredentialEditRef = useRef<{
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
    setOpenCodeZenApiKey(pendingOpenCodeZenCredentialEditRef.current?.apiKey ?? "");
    setClearOpenCodeZenApiKey(pendingOpenCodeZenCredentialEditRef.current?.clear ?? false);
    setUseHostGitHubCredentials(global.useHostGitHubCredentials ?? true);
    setSshAgentSocketPath(global.sshAgentSocketPath ?? "");
    setUseHostClaudeCredentials(global.useHostClaudeCredentials ?? true);
    setGithubToken(pendingGitHubCredentialEditRef.current?.token ?? "");
    setClearGithubToken(pendingGitHubCredentialEditRef.current?.clear ?? false);
    setAllowedDomains((global.allowedDomains || []).join("\n"));
    setPreferredEditor(global.preferredEditor || "vscode");
    setEnabledAgentPlatforms(global.enabledAgentPlatforms ?? ["claude", "codex", "opencode"]);
    setCoordinatorProviderTiers(
      global.coordinatorProviderTiers ?? DEFAULT_COORDINATOR_PROVIDER_TIER,
    );
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
    setTerminalHistoryEnabled(global.terminalHistoryEnabled ?? DEFAULT_TERMINAL_HISTORY_ENABLED);
    setTerminalHistoryRetentionMb(
      global.terminalHistoryRetentionMb ?? DEFAULT_TERMINAL_HISTORY_RETENTION_MB,
    );
    setTerminalHistoryGlobalRetentionMb(
      global.terminalHistoryGlobalRetentionMb ?? DEFAULT_TERMINAL_HISTORY_GLOBAL_RETENTION_MB,
    );
    setTerminalHistoryRetentionDays(
      global.terminalHistoryRetentionDays ?? DEFAULT_TERMINAL_HISTORY_RETENTION_DAYS,
    );
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

  // What the shared auto-save would persist for the current edit. Kept in a
  // ref so the debounce effect can tell a fresh edit from one that already
  // failed, and refuse to spin retrying a value the backend rejects.
  const coreSignatureRef = useRef("");
  const failedCoreSignatureRef = useRef<string | null>(null);
  const persistCoreRef = useRef<() => Promise<void>>(async () => {});

  // Detect changes to the fields the debounced auto-save owns. Credentials are
  // excluded on purpose: they persist when their field loses focus, so a pause
  // mid-typing cannot store a partial secret and then clear the field out from
  // under the user. Keep this list in step with the `global` it compares to.
  useEffect(() => {
    const terminalAppearance = global.terminalAppearance || DEFAULT_TERMINAL_APPEARANCE;
    coreSignatureRef.current = JSON.stringify([
      cpuCores,
      memoryGb,
      envPatterns,
      useHostGitHubCredentials,
      sshAgentSocketPath,
      useHostClaudeCredentials,
      githubCredentialPropagationPending,
      allowedDomains,
      preferredEditor,
      enabledAgentPlatforms,
      coordinatorProviderTiers,
      agentSettings,
      openCodeModelProviders,
      codexMaxConcurrentThreads,
      terminalFontFamily,
      terminalFontSize,
      terminalBackgroundColor,
      terminalScrollback,
      terminalHistoryEnabled,
      terminalHistoryRetentionMb,
      terminalHistoryGlobalRetentionMb,
      terminalHistoryRetentionDays,
      experimentalCodexRawEventLogging,
      debugLogging,
      debugLogRetentionDays,
      webClientEnabled,
      reviewInstruction,
    ]);
    const changed =
      cpuCores !== global.containerResources.cpuCores ||
      memoryGb !== global.containerResources.memoryGb ||
      envPatterns !== global.envFilePatterns.join(", ") ||
      useHostGitHubCredentials !== (global.useHostGitHubCredentials ?? true) ||
      sshAgentSocketPath !== (global.sshAgentSocketPath ?? "") ||
      useHostClaudeCredentials !== (global.useHostClaudeCredentials ?? true) ||
      githubCredentialPropagationPending ||
      allowedDomains !== (global.allowedDomains || []).join("\n") ||
      preferredEditor !== (global.preferredEditor || "vscode") ||
      JSON.stringify(enabledAgentPlatforms) !==
        JSON.stringify(global.enabledAgentPlatforms ?? ["claude", "codex", "opencode"]) ||
      coordinatorProviderTiers !==
        (global.coordinatorProviderTiers ?? DEFAULT_COORDINATOR_PROVIDER_TIER) ||
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
      terminalHistoryEnabled !==
        (global.terminalHistoryEnabled ?? DEFAULT_TERMINAL_HISTORY_ENABLED) ||
      terminalHistoryRetentionMb !==
        (global.terminalHistoryRetentionMb ?? DEFAULT_TERMINAL_HISTORY_RETENTION_MB) ||
      terminalHistoryGlobalRetentionMb !==
        (global.terminalHistoryGlobalRetentionMb ?? DEFAULT_TERMINAL_HISTORY_GLOBAL_RETENTION_MB) ||
      terminalHistoryRetentionDays !==
        (global.terminalHistoryRetentionDays ?? DEFAULT_TERMINAL_HISTORY_RETENTION_DAYS) ||
      experimentalCodexRawEventLogging !== (global.experimentalCodexRawEventLogging ?? true) ||
      debugLogging !== (global.debugLogging ?? false) ||
      debugLogRetentionDays !== normalizeDebugLogRetentionDays(global.debugLogRetentionDays) ||
      webClientEnabled !== (global.webClientEnabled ?? true) ||
      reviewInstruction !== getSavedReviewInstruction(global.reviewInstruction);
    setCoreHasChanges(changed);
  }, [
    cpuCores,
    memoryGb,
    envPatterns,
    useHostGitHubCredentials,
    sshAgentSocketPath,
    useHostClaudeCredentials,
    githubCredentialPropagationPending,
    allowedDomains,
    preferredEditor,
    enabledAgentPlatforms,
    coordinatorProviderTiers,
    agentSettings,
    openCodeModelProviders,
    codexMaxConcurrentThreads,
    terminalFontFamily,
    terminalFontSize,
    terminalBackgroundColor,
    terminalScrollback,
    terminalHistoryEnabled,
    terminalHistoryRetentionMb,
    terminalHistoryGlobalRetentionMb,
    terminalHistoryRetentionDays,
    experimentalCodexRawEventLogging,
    debugLogging,
    debugLogRetentionDays,
    webClientEnabled,
    reviewInstruction,
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

  /**
   * Push the selected GitHub credential source to every running container.
   *
   * A failure is retained in `githubCredentialPropagationPending` so the next
   * edit retries it rather than silently leaving containers on stale
   * credentials.
   */
  const propagateGithubCredentials = async () => {
    try {
      const propagateResult = await backend.propagateGithubCredentialsToContainers();
      if (propagateResult.failed.length > 0) {
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
          ]
            .filter(Boolean)
            .join(" "),
        });
        return;
      }
      setGithubCredentialPropagationPending(false);
      if (propagateResult.updated.length > 0) {
        toast.success(
          `Updated GitHub credentials in ${propagateResult.updated.length} container(s)`,
        );
      }
    } catch (err) {
      console.error("[settings] Failed to propagate GitHub credentials:", err);
      setGithubCredentialPropagationPending(true);
      const message = err instanceof Error ? err.message : String(err);
      toast.error("Settings saved, but containers were not updated", {
        description: message,
      });
    }
  };

  /**
   * Persist every non-secret setting the shared form owns.
   *
   * Auto-save owns this path: it runs debounced whenever any of those fields
   * changes, and on its own it never touches a credential. Credentials are
   * written by `persistCredential` when their field loses focus, so pausing
   * mid-typing cannot store a partial secret and then clear the field.
   */
  const persistCore = async () => {
    const signature = coreSignatureRef.current;
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
      const savedSshAgentSocketPath = sshAgentSocketPathForSave(sshAgentSocketPath);

      const newGlobal: {
        containerResources: { cpuCores: number; memoryGb: number };
        envFilePatterns: string[];
        allowedDomains: string[];
        useHostGitHubCredentials: boolean;
        sshAgentSocketPath?: string;
        useHostClaudeCredentials: boolean;
        preferredEditor?: PreferredEditor;
        enabledAgentPlatforms: AgentPlatform[];
        coordinatorProviderTiers: "enforced" | "provider-configured" | "advisory";
        favoriteModels: Array<{ platform: AgentPlatform; modelId: string }>;
        agentSettings: AgentSettingsTier;
        openCodeModelProviders: string[];
        codexMaxConcurrentThreads: number;
        terminalAppearance: TerminalAppearance;
        terminalScrollback: number;
        terminalHistoryEnabled: boolean;
        terminalHistoryRetentionMb: number;
        terminalHistoryGlobalRetentionMb: number;
        terminalHistoryRetentionDays: number;
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
        ...(savedSshAgentSocketPath ? { sshAgentSocketPath: savedSshAgentSocketPath } : {}),
        useHostClaudeCredentials,
        preferredEditor,
        enabledAgentPlatforms,
        coordinatorProviderTiers,
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
        terminalHistoryEnabled,
        terminalHistoryRetentionMb,
        terminalHistoryGlobalRetentionMb,
        terminalHistoryRetentionDays,
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

      const newConfig = await backend.updateGlobalConfig(newGlobal);
      setConfig(newConfig);
      const githubCredentialSourceChanged =
        useHostGitHubCredentials !== (global.useHostGitHubCredentials ?? true);

      if (
        !window.orkestratorGateway?.enabled &&
        webClientEnabled !== (global.webClientEnabled ?? true)
      ) {
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

      // Apply the selected credential source to running containers if it changed,
      // or retry a previous partial propagation failure.
      if (githubCredentialSourceChanged || githubCredentialPropagationPending) {
        await propagateGithubCredentials();
      }
      failedCoreSignatureRef.current = null;
    } catch (err) {
      // Remember the exact edit the backend rejected so the debounce effect does
      // not spin retrying it; any further edit retries naturally.
      failedCoreSignatureRef.current = signature;
      console.error("[settings] Failed to save config:", err);
      const message = err instanceof Error ? err.message : "Failed to save settings";
      toast.error("Failed to save settings", { description: message });
    } finally {
      setIsSaving(false);
    }
  };

  type CredentialField = "anthropic" | "cursor" | "opencode-zen" | "github";

  const writeCredential = async (field: CredentialField, value: string | null) => {
    let nextConfig;
    if (field === "anthropic") nextConfig = await backend.setAnthropicApiKey(value);
    else if (field === "cursor") nextConfig = await backend.setCursorApiKey(value);
    else if (field === "opencode-zen") nextConfig = await backend.setOpenCodeZenApiKey(value);
    else nextConfig = await backend.setGitHubToken(value);
    setConfig(nextConfig);
    if (field !== "github") setPlanUsageRefreshToken((token) => token + 1);
  };

  const clearCredentialField = (field: CredentialField) => {
    if (field === "anthropic") {
      setAnthropicApiKey("");
      setClearAnthropicApiKey(false);
      pendingAnthropicCredentialEditRef.current = null;
    } else if (field === "cursor") {
      setCursorApiKey("");
      setClearCursorApiKey(false);
      pendingCursorCredentialEditRef.current = null;
    } else if (field === "opencode-zen") {
      setOpenCodeZenApiKey("");
      setClearOpenCodeZenApiKey(false);
      pendingOpenCodeZenCredentialEditRef.current = null;
    } else {
      setGithubToken("");
      setClearGithubToken(false);
      pendingGitHubCredentialEditRef.current = null;
    }
  };

  /**
   * Save one credential when its field loses focus.
   *
   * A secret is deliberately not debounced with the rest of the form:
   * auto-saving it while the user is still typing would persist a prefix and
   * clear the field, so the remainder would overwrite the real key. Blur is
   * the first moment the value is whole.
   */
  const persistCredential = async (field: CredentialField) => {
    const draft = {
      anthropic: { value: anthropicApiKey, clear: clearAnthropicApiKey },
      cursor: { value: cursorApiKey, clear: clearCursorApiKey },
      "opencode-zen": { value: openCodeZenApiKey, clear: clearOpenCodeZenApiKey },
      github: { value: githubToken, clear: clearGithubToken },
    }[field];
    const trimmed = draft.value.trim();
    if (!draft.clear && trimmed.length === 0) return;
    setIsSaving(true);
    try {
      await writeCredential(field, draft.clear ? null : trimmed);
      clearCredentialField(field);
      if (field === "github") await propagateGithubCredentials();
    } catch (err) {
      console.error("[settings] Failed to save credential:", err);
      const message = err instanceof Error ? err.message : "Failed to save settings";
      toast.error("Failed to save settings", { description: message });
    } finally {
      setIsSaving(false);
    }
  };

  /** Clear a stored credential immediately, without waiting for a form submit. */
  const clearCredential = async (field: CredentialField) => {
    setIsSaving(true);
    try {
      await writeCredential(field, null);
      clearCredentialField(field);
      if (field === "github") await propagateGithubCredentials();
    } catch (err) {
      console.error("[settings] Failed to clear credential:", err);
      const message = err instanceof Error ? err.message : "Failed to clear credential";
      toast.error("Failed to clear credential", { description: message });
    } finally {
      setIsSaving(false);
    }
  };

  const persistGatewayToken = async () => {
    if (!gatewayTokenSettings?.editable) return;
    if (gatewayToken === savedGatewayToken) return;
    if (getGatewayTokenValidationError(gatewayToken)) return;
    setIsSaving(true);
    try {
      const nextGatewayTokenSettings = await backend.setGatewayToken(gatewayToken);
      setGatewayTokenSettings(nextGatewayTokenSettings);
      setGatewayToken(nextGatewayTokenSettings.token);
      setSavedGatewayToken(nextGatewayTokenSettings.token);
    } catch (err) {
      console.error("[settings] Failed to save gateway token:", err);
      const message = err instanceof Error ? err.message : "Failed to save settings";
      toast.error("Failed to save gateway token", { description: message });
    } finally {
      setIsSaving(false);
    }
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
    openCodeZenApiKey,
    setOpenCodeZenApiKey,
    clearOpenCodeZenApiKey,
    setClearOpenCodeZenApiKey,
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
    coordinatorProviderTiers,
    setCoordinatorProviderTiers,
    openCodeModelProviders,
    setOpenCodeModelProviders,
    planUsageRefreshToken,
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
    terminalHistoryEnabled,
    setTerminalHistoryEnabled,
    terminalHistoryRetentionMb,
    setTerminalHistoryRetentionMb,
    terminalHistoryGlobalRetentionMb,
    setTerminalHistoryGlobalRetentionMb,
    terminalHistoryRetentionDays,
    setTerminalHistoryRetentionDays,
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
    showOpenCodeZenApiKey,
    setShowOpenCodeZenApiKey,
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
    persistCredential,
    clearCredential,
    persistGatewayToken,
  };

  // A validation failure in one section blocks auto-save for every section: the
  // whole form is written in one `update_global_config`, so a bad value in
  // Network or Terminal would otherwise ship alongside an otherwise valid edit.
  const saveBlocker = useMemo(() => {
    const blockers: Array<{ section: string; message: string }> = [];
    if (domainErrors.length > 0) {
      blockers.push({
        section: "network",
        message: "Fix the allowed-domain errors in Network before saving.",
      });
    }
    if (colorError) blockers.push({ section: "terminal", message: colorError });
    if (
      terminalHistoryEnabled &&
      (!Number.isInteger(terminalHistoryRetentionMb) ||
        terminalHistoryRetentionMb < MIN_TERMINAL_HISTORY_RETENTION_MB ||
        terminalHistoryRetentionMb > MAX_TERMINAL_HISTORY_RETENTION_MB ||
        !Number.isInteger(terminalHistoryGlobalRetentionMb) ||
        terminalHistoryGlobalRetentionMb < MIN_TERMINAL_HISTORY_GLOBAL_RETENTION_MB ||
        terminalHistoryGlobalRetentionMb > MAX_TERMINAL_HISTORY_GLOBAL_RETENTION_MB ||
        !Number.isInteger(terminalHistoryRetentionDays) ||
        terminalHistoryRetentionDays < MIN_TERMINAL_HISTORY_RETENTION_DAYS ||
        terminalHistoryRetentionDays > MAX_TERMINAL_HISTORY_RETENTION_DAYS)
    ) {
      blockers.push({
        section: "terminal",
        message: "Terminal history retention values are outside their allowed ranges.",
      });
    }
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
    terminalHistoryEnabled,
    terminalHistoryRetentionMb,
    terminalHistoryGlobalRetentionMb,
    terminalHistoryRetentionDays,
    debugLogRetentionDays,
    gatewayTokenValidationError,
    reviewInstructionValidationError,
    sshAgentSocketPathValidationError,
  ]);
  // Debounced auto-save. `coreHasChanges` flips as the form diverges from the
  // persisted config; the timer is cleared on every change and on unmount, so a
  // slider drag or a burst of typing persists once, after the user stops. A
  // rejected signature is not retried until the value changes again.
  persistCoreRef.current = persistCore;
  useEffect(() => {
    if (!coreHasChanges || isSaving || saveBlocker) return;
    if (failedCoreSignatureRef.current === coreSignatureRef.current) return;
    const timer = setTimeout(() => {
      void persistCoreRef.current();
    }, AUTO_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [coreHasChanges, isSaving, saveBlocker]);

  return <GlobalSettingsSections activeSection={activeSection} settings={sectionSettings} />;
}
