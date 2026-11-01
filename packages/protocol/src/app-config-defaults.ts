/**
 * The configuration a new install starts with.
 *
 * The backend persists this on first run and every client renders it until the
 * backend's config arrives, so both build it here rather than keeping copies
 * that drift (the renderer's copy once woke peers the backend did not, listed
 * env files in a different order and omitted whole sections).
 *
 * The returned value is fresh on every call: callers mutate it.
 */
import { LEGACY_ENABLED_AGENT_PLATFORMS, type AgentPlatform } from "./agent-platforms.js";
import { DEFAULT_AGENT_MESSAGING_SETTINGS } from "./agent-mail.js";
import { DEFAULT_CODEX_MODEL_ID, DEFAULT_CODEX_REASONING_EFFORT } from "./codex-model-catalog.js";
import { COORDINATOR_PROVIDER_TIER_DEFAULT_VERSION } from "./coordinator.js";
import { DEFAULT_DEBUG_LOG_RETENTION_DAYS } from "./debug-logging.js";
import { DEFAULT_OPENCODE_MODEL_PROVIDERS } from "./native-agent.js";
import { DEFAULT_ALLOWED_DOMAINS } from "./network-allowlist.js";
import { DEFAULT_NOTIFICATION_SOUND_SETTINGS } from "./notification-sounds.js";
import { DEFAULT_CLAUDE_MODE } from "./startup-launch.js";
import {
  DEFAULT_TERMINAL_HISTORY_ENABLED,
  DEFAULT_TERMINAL_HISTORY_GLOBAL_RETENTION_MB,
  DEFAULT_TERMINAL_HISTORY_RETENTION_DAYS,
  DEFAULT_TERMINAL_HISTORY_RETENTION_MB,
} from "./terminal-history.js";

export const DEFAULT_APP_CONFIG_SCHEMA_VERSION = 2;
export const DEFAULT_APP_CONFIG_VERSION = "1.0.0";

export const DEFAULT_CODEX_MAX_CONCURRENT_THREADS = 5;

export const DEFAULT_TERMINAL_BACKGROUND_COLOR = "#0e1014";
export const DEFAULT_TERMINAL_FONT_FAMILY = "FiraCode Nerd Font";
export const DEFAULT_TERMINAL_FONT_SIZE = 14;
/** Default terminal scrollback buffer, in lines. */
export const DEFAULT_TERMINAL_SCROLLBACK = 1000;

export const DEFAULT_ENV_FILE_PATTERNS: readonly string[] = Object.freeze([".env", ".env.local"]);

/** The stored Claude model for a new install. */
export const DEFAULT_CLAUDE_MODEL_ID = "claude-sonnet-5-5";

export function createDefaultGlobalConfig() {
  return {
    containerResources: { cpuCores: 2, memoryGb: 4 },
    envFilePatterns: [...DEFAULT_ENV_FILE_PATTERNS],
    useHostGitHubCredentials: true,
    useHostClaudeCredentials: true,
    allowedDomains: [...DEFAULT_ALLOWED_DOMAINS],
    enabledAgentPlatforms: [...LEGACY_ENABLED_AGENT_PLATFORMS],
    coordinatorProviderTierDefaultVersion: COORDINATOR_PROVIDER_TIER_DEFAULT_VERSION,
    favoriteModels: [] as Array<{ platform: AgentPlatform; modelId: string }>,
    agentMessaging: { ...DEFAULT_AGENT_MESSAGING_SETTINGS },
    agentSettings: {
      defaultAgent: "claude" as const,
      platforms: {
        claude: {
          mode: DEFAULT_CLAUDE_MODE,
          model: DEFAULT_CLAUDE_MODEL_ID,
          claudeNativeBackend: "sdk" as const,
        },
        // New installs only. An existing config.json already holds a concrete
        // effort, and nothing records whether the user chose it or merely
        // inherited the previous "medium" default, so migrating would
        // overwrite deliberate choices. Existing installs keep their stored
        // value until the user changes it in settings.
        codex: {
          mode: "native" as const,
          model: DEFAULT_CODEX_MODEL_ID,
          reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
        },
        // No model: unset is OpenCode's own default among the connected,
        // allowlisted providers, which no fixed id can match for every login.
        opencode: { mode: "terminal" as const },
        grok: { mode: "terminal" as const },
      },
    },
    openCodeModelProviders: [...DEFAULT_OPENCODE_MODEL_PROVIDERS],
    codexMaxConcurrentThreads: DEFAULT_CODEX_MAX_CONCURRENT_THREADS,
    terminalAppearance: {
      fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
      fontSize: DEFAULT_TERMINAL_FONT_SIZE,
      backgroundColor: DEFAULT_TERMINAL_BACKGROUND_COLOR,
    },
    terminalScrollback: DEFAULT_TERMINAL_SCROLLBACK,
    terminalHistoryEnabled: DEFAULT_TERMINAL_HISTORY_ENABLED,
    terminalHistoryRetentionMb: DEFAULT_TERMINAL_HISTORY_RETENTION_MB,
    terminalHistoryGlobalRetentionMb: DEFAULT_TERMINAL_HISTORY_GLOBAL_RETENTION_MB,
    terminalHistoryRetentionDays: DEFAULT_TERMINAL_HISTORY_RETENTION_DAYS,
    experimentalCodexRawEventLogging: true,
    debugLogging: false,
    debugLogRetentionDays: DEFAULT_DEBUG_LOG_RETENTION_DAYS,
    webClientEnabled: true,
    notificationSounds: { ...DEFAULT_NOTIFICATION_SOUND_SETTINGS },
  };
}

export function createDefaultAppConfig() {
  return {
    schemaVersion: DEFAULT_APP_CONFIG_SCHEMA_VERSION,
    version: DEFAULT_APP_CONFIG_VERSION,
    global: createDefaultGlobalConfig(),
    repositories: {},
  };
}
