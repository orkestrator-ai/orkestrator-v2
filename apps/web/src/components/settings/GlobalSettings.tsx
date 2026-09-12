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

// The debounce effect re-arms on every edit, so a save that changes nothing is
// stopped instead of retried forever. A failed propagation is retried a bounded
// number of times before the form gives up and waits for the user.
const MAX_GITHUB_PROPAGATION_RETRIES = 2;

/** Filenames are case-sensitive, so these dedupe exactly. */
export function normalizeEnvPatternsInput(value: string | string[]): string[] {
  const list = Array.isArray(value) ? value : value.split(",");
  return [...new Set(list.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}

/**
 * DNS is not case-sensitive, so `example.com` and `Example.com` are one domain.
 * The first spelling the user typed is the one kept.
 */
export function normalizeAllowedDomainsInput(value: string | string[]): string[] {
  const list = Array.isArray(value) ? value : value.split("\n");
  const domains: string[] = [];
  const seen = new Set<string>();
  for (const entry of list.map((domain) => domain.trim())) {
    if (entry.length === 0 || seen.has(entry.toLowerCase())) continue;
    seen.add(entry.toLowerCase());
    domains.push(entry);
  }
  return domains;
}

/**
 * Every non-secret setting the shared form owns, normalized to the shape that is
 * actually persisted. Comparing a normalized local snapshot against the stored
 * config is what stops a save that changes nothing from re-arming the debounce.
 */
interface CoreFieldsSnapshot {
  containerResources: { cpuCores: number; memoryGb: number };
  envFilePatterns: string[];
  allowedDomains: string[];
  useHostGitHubCredentials: boolean;
  sshAgentSocketPath: string;
  useHostClaudeCredentials: boolean;
  preferredEditor: PreferredEditor;
  enabledAgentPlatforms: AgentPlatform[];
  coordinatorProviderTiers: "enforced" | "provider-configured" | "advisory";
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
  reviewInstruction: string;
}

/** The same fields as `CoreFieldsSnapshot`, read from the persisted config. */
export function storedCoreFields(global: GlobalConfig): CoreFieldsSnapshot {
  const appearance = global.terminalAppearance || DEFAULT_TERMINAL_APPEARANCE;
  return {
    containerResources: {
      cpuCores: global.containerResources.cpuCores,
      memoryGb: global.containerResources.memoryGb,
    },
    envFilePatterns: normalizeEnvPatternsInput(global.envFilePatterns),
    allowedDomains: normalizeAllowedDomainsInput(global.allowedDomains ?? []),
    useHostGitHubCredentials: global.useHostGitHubCredentials ?? true,
    sshAgentSocketPath: global.sshAgentSocketPath ?? "",
    useHostClaudeCredentials: global.useHostClaudeCredentials ?? true,
    preferredEditor: global.preferredEditor ?? "vscode",
    enabledAgentPlatforms: global.enabledAgentPlatforms ?? ["claude", "codex", "opencode"],
    coordinatorProviderTiers: global.coordinatorProviderTiers ?? DEFAULT_COORDINATOR_PROVIDER_TIER,
    agentSettings: normalizeAgentSettings(global.agentSettings),
    openCodeModelProviders: normalizeOpenCodeModelProviders(global.openCodeModelProviders),
    codexMaxConcurrentThreads:
      global.codexMaxConcurrentThreads ?? DEFAULT_CODEX_MAX_CONCURRENT_THREADS,
    terminalAppearance: {
      fontFamily: appearance.fontFamily,
      fontSize: appearance.fontSize,
      backgroundColor: appearance.backgroundColor,
    },
    terminalScrollback: global.terminalScrollback ?? DEFAULT_TERMINAL_SCROLLBACK,
    terminalHistoryEnabled: global.terminalHistoryEnabled ?? DEFAULT_TERMINAL_HISTORY_ENABLED,
    terminalHistoryRetentionMb:
      global.terminalHistoryRetentionMb ?? DEFAULT_TERMINAL_HISTORY_RETENTION_MB,
    terminalHistoryGlobalRetentionMb:
      global.terminalHistoryGlobalRetentionMb ?? DEFAULT_TERMINAL_HISTORY_GLOBAL_RETENTION_MB,
    terminalHistoryRetentionDays:
      global.terminalHistoryRetentionDays ?? DEFAULT_TERMINAL_HISTORY_RETENTION_DAYS,
    experimentalCodexRawEventLogging: global.experimentalCodexRawEventLogging ?? true,
    debugLogging: global.debugLogging ?? false,
    debugLogRetentionDays: normalizeDebugLogRetentionDays(global.debugLogRetentionDays),
    webClientEnabled: global.webClientEnabled ?? true,
    reviewInstruction: getSavedReviewInstruction(global.reviewInstruction),
  };
}

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
  const [cursorApiKey, setCursorApiKey] = useState("");
  const [openCodeZenApiKey, setOpenCodeZenApiKey] = useState("");
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
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
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
    // Credential inputs are deliberately not reset here. They are write-only and
    // cleared explicitly once their save succeeds, so preserving whatever is
    // typed keeps a rejected secret retryable across an unrelated store write.
    setUseHostGitHubCredentials(global.useHostGitHubCredentials ?? true);
    setSshAgentSocketPath(global.sshAgentSocketPath ?? "");
    setUseHostClaudeCredentials(global.useHostClaudeCredentials ?? true);
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
  const githubPropagationRetryCountRef = useRef(0);
  const githubPropagationFailureToastShownRef = useRef(false);

  // The normalized values the form would persist, alongside the same fields as
  // they are stored. Comparing normalized-to-normalized is what lets a save that
  // changes nothing — a trailing space, a duplicate domain — settle instead of
  // re-arming the debounce on every interval. Credentials are excluded on
  // purpose: they persist when their field loses focus, so a pause mid-typing
  // cannot store a partial secret.
  const localCoreFields = useMemo<CoreFieldsSnapshot>(
    () => ({
      containerResources: { cpuCores, memoryGb },
      envFilePatterns: normalizeEnvPatternsInput(envPatterns),
      allowedDomains: normalizeAllowedDomainsInput(allowedDomains),
      useHostGitHubCredentials,
      sshAgentSocketPath: sshAgentSocketPathForSave(sshAgentSocketPath) ?? "",
      useHostClaudeCredentials,
      preferredEditor,
      enabledAgentPlatforms,
      coordinatorProviderTiers,
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
      reviewInstruction,
    }),
    [
      cpuCores,
      memoryGb,
      envPatterns,
      allowedDomains,
      useHostGitHubCredentials,
      sshAgentSocketPath,
      useHostClaudeCredentials,
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
    ],
  );
  const localCoreSignature = useMemo(() => JSON.stringify(localCoreFields), [localCoreFields]);
  const storedCoreSignature = useMemo(() => JSON.stringify(storedCoreFields(global)), [global]);
  const coreHasChanges =
    localCoreSignature !== storedCoreSignature || githubCredentialPropagationPending;
  coreSignatureRef.current = localCoreSignature;

  // Latest-value mirrors for the unmount flush. Its effect must run once, so it
  // cannot depend on state that changes on every render; the refs carry the
  // current values into the cleanup instead.
  const coreHasChangesRef = useRef(coreHasChanges);
  coreHasChangesRef.current = coreHasChanges;
  const isSavingRef = useRef(isSaving);
  isSavingRef.current = isSaving;
  const saveBlockerRef = useRef<{ section: string; message: string } | null>(null);

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
   * save retries it, but only for a bounded number of attempts: a container that
   * stays unreachable must not turn the form into a write/toast loop. The failure
   * toast is shown once per episode rather than on every retry.
   */
  const propagateGithubCredentials = async () => {
    let failureMessage = "Settings saved, but containers were not updated";
    let failureDescription: string | undefined;
    try {
      const propagateResult = await backend.propagateGithubCredentialsToContainers();
      if (propagateResult.failed.length === 0) {
        githubPropagationRetryCountRef.current = 0;
        githubPropagationFailureToastShownRef.current = false;
        setGithubCredentialPropagationPending(false);
        if (propagateResult.updated.length > 0) {
          toast.success(
            `Updated GitHub credentials in ${propagateResult.updated.length} container(s)`,
          );
        }
        return;
      }
      const failureDetails = propagateResult.failed
        .slice(0, 3)
        .map(([environmentId, message]) => `${environmentId}: ${message}`)
        .join("; ");
      const remainingFailureCount = Math.max(0, propagateResult.failed.length - 3);
      failureMessage = "Settings saved, but some containers were not updated";
      failureDescription = [
        propagateResult.updated.length > 0
          ? `Updated ${propagateResult.updated.length} container(s).`
          : null,
        `Failed: ${failureDetails}${remainingFailureCount > 0 ? `; and ${remainingFailureCount} more` : ""}.`,
      ]
        .filter(Boolean)
        .join(" ");
    } catch (err) {
      console.error("[settings] Failed to propagate GitHub credentials:", err);
      failureDescription = err instanceof Error ? err.message : String(err);
    }

    githubPropagationRetryCountRef.current += 1;
    const retriesExhausted =
      githubPropagationRetryCountRef.current > MAX_GITHUB_PROPAGATION_RETRIES;
    setGithubCredentialPropagationPending(!retriesExhausted);
    if (!githubPropagationFailureToastShownRef.current) {
      githubPropagationFailureToastShownRef.current = true;
      toast.error(failureMessage, {
        description: failureDescription,
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
    setSaveState("saving");
    try {
      const patterns = normalizeEnvPatternsInput(envPatterns);
      const domains = normalizeAllowedDomainsInput(allowedDomains);
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

      const githubCredentialSourceChanged =
        useHostGitHubCredentials !== (global.useHostGitHubCredentials ?? true);
      if (githubCredentialSourceChanged) {
        // A new source is a fresh episode: give propagation its retries again.
        githubPropagationRetryCountRef.current = 0;
        githubPropagationFailureToastShownRef.current = false;
      }

      const newConfig = await backend.updateGlobalConfig(newGlobal);
      if (coreSignatureRef.current !== signature) {
        // An edit landed while this write was in flight. Mark the returned store
        // state as already accounted for so the sync effect does not reset the
        // form to this write's values and discard the newer edit; the debounce
        // will persist it next.
        syncedGlobalSignatureRef.current = globalFormSignature(newConfig.global);
      }
      setConfig(newConfig);
      if (useHostClaudeCredentials !== (global.useHostClaudeCredentials ?? true)) {
        // The Claude plan read goes unavailable when host credentials are off,
        // so the card must re-read rather than serve the pre-toggle snapshot.
        setPlanUsageRefreshToken((token) => token + 1);
      }

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
      setSaveState("saved");
    } catch (err) {
      // Remember the exact edit the backend rejected so the debounce effect does
      // not spin retrying it; any further edit retries naturally.
      failedCoreSignatureRef.current = signature;
      setSaveState("error");
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
    if (field === "anthropic") setAnthropicApiKey("");
    else if (field === "cursor") setCursorApiKey("");
    else if (field === "opencode-zen") setOpenCodeZenApiKey("");
    else setGithubToken("");
  };

  const resetGithubPropagationRetries = () => {
    githubPropagationRetryCountRef.current = 0;
    githubPropagationFailureToastShownRef.current = false;
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
    const value = {
      anthropic: anthropicApiKey,
      cursor: cursorApiKey,
      "opencode-zen": openCodeZenApiKey,
      github: githubToken,
    }[field].trim();
    if (value.length === 0) return;
    setIsSaving(true);
    try {
      await writeCredential(field, value);
      clearCredentialField(field);
      if (field === "github") {
        resetGithubPropagationRetries();
        await propagateGithubCredentials();
      }
    } catch (err) {
      console.error("[settings] Failed to save credential:", err);
      const message = err instanceof Error ? err.message : "Failed to save settings";
      toast.error("Failed to save settings", { description: message });
    } finally {
      setIsSaving(false);
    }
  };

  /** Clear a stored credential, after the section has asked for confirmation. */
  const clearCredential = async (field: CredentialField) => {
    setIsSaving(true);
    try {
      await writeCredential(field, null);
      clearCredentialField(field);
      if (field === "github") {
        resetGithubPropagationRetries();
        await propagateGithubCredentials();
      }
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
    cursorApiKey,
    setCursorApiKey,
    openCodeZenApiKey,
    setOpenCodeZenApiKey,
    useHostGitHubCredentials,
    setUseHostGitHubCredentials,
    sshAgentSocketPath,
    setSshAgentSocketPath,
    sshAgentSocketPathValidationError,
    useHostClaudeCredentials,
    setUseHostClaudeCredentials,
    githubToken,
    setGithubToken,
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
    setPlanUsageRefreshToken,
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
    reviewInstructionValidationError,
    sshAgentSocketPathValidationError,
  ]);
  saveBlockerRef.current = saveBlocker;

  // Debounced auto-save. `coreHasChanges` flips as the form diverges from the
  // persisted config. The effect depends on the local signature, so every edit
  // clears and re-arms the timer and only the final value is written. A rejected
  // signature is not retried until the value changes again.
  persistCoreRef.current = persistCore;
  useEffect(() => {
    if (!coreHasChanges || isSaving || saveBlocker) return;
    if (failedCoreSignatureRef.current === localCoreSignature) return;
    const timer = setTimeout(() => {
      void persistCoreRef.current();
    }, AUTO_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [coreHasChanges, localCoreSignature, isSaving, saveBlocker]);

  // DEBUG: trace auto-save effect
  useEffect(() => {
    console.log("[DEBUG] auto-save effect ran", {
      coreHasChanges,
      isSaving,
      saveBlocker: !!saveBlocker,
      localCoreSignature,
    });
  }, [coreHasChanges, localCoreSignature, isSaving, saveBlocker]);

  // Closing Settings, or switching to Messaging/Skills/MCP/Connections, unmounts
  // this form. Flush a still-debounced edit so it is not silently dropped when
  // the Save button that once covered it is gone.
  useEffect(() => {
    return () => {
      if (!coreHasChangesRef.current || isSavingRef.current || saveBlockerRef.current) return;
      if (failedCoreSignatureRef.current === coreSignatureRef.current) return;
      void persistCoreRef.current();
    };
  }, []);

  const SAVE_BLOCKER_SECTION_LABELS: Record<string, string> = {
    network: "Network",
    terminal: "Terminal",
    debug: "Debug",
    review: "Review",
    general: "General",
  };
  const saveStatus = saveBlocker
    ? {
        tone: "blocked" as const,
        text: `Not saved — ${saveBlocker.message} (${SAVE_BLOCKER_SECTION_LABELS[saveBlocker.section] ?? saveBlocker.section})`,
      }
    : isSaving
      ? { tone: "pending" as const, text: "Saving…" }
      : saveState === "error"
        ? { tone: "blocked" as const, text: "Changes could not be saved." }
        : coreHasChanges
          ? { tone: "pending" as const, text: "Unsaved changes" }
          : saveState === "saved"
            ? { tone: "saved" as const, text: "All changes saved" }
            : null;

  return (
    <div className="flex h-full flex-col">
      {saveStatus && (
        <div
          role="status"
          aria-live="polite"
          className={
            saveStatus.tone === "blocked"
              ? "mb-4 rounded-md border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2 text-xs text-amber-300"
              : saveStatus.tone === "pending"
                ? "mb-4 rounded-md border border-border/60 bg-zinc-900/50 px-3 py-2 text-xs text-muted-foreground"
                : "mb-4 rounded-md border border-emerald-500/20 bg-emerald-500/[0.04] px-3 py-2 text-xs text-emerald-400/90"
          }
        >
          {saveStatus.text}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <GlobalSettingsSections activeSection={activeSection} settings={sectionSettings} />
      </div>
    </div>
  );
}
