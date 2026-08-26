/**
 * Who owns an environment's startup agent launch.
 *
 * Two processes act on the same `pendingAgentLaunch`: the backend's native
 * agent service dispatches the initial prompt (staging its image attachments
 * into the workspace on the way), and the renderer seeds the startup tab. Only
 * one of them may consume the attachments — the renderer's fallback rewrites
 * the prompt into a list of workspace paths and clears the stored images, which
 * is correct for a PTY that cannot carry an attachment and destructive for a
 * native launch that can.
 *
 * The decision therefore has to be identical on both sides. It used to be
 * written twice, over different configuration chains: the backend consulted the
 * repository tier for `defaultAgent` but not for the Claude style, while the
 * renderer did the reverse, and the two disagreed about the default Codex mode.
 * Any disagreement is silent and costs the user their image — either both paths
 * run and race, or neither delivers it. This module is the single answer both
 * import.
 */
import type { AgentPlatform } from "./agent-platforms.js";
import {
  DEFAULT_AGENT_PLATFORM,
  resolveAgentPlatformSettings,
  resolveDefaultAgent,
  SHIPPED_PLATFORM_MODES,
  type AgentSettingsTier,
  type AgentSettingsTiers,
} from "./agent-settings.js";

export type StartupLaunchMode = "terminal" | "native";
export type StartupLaunchClaudeBackend = "sdk" | "tmux";

/** Per-environment overrides; the highest-priority tier. */
export interface StartupLaunchEnvironmentSettings {
  defaultAgent?: AgentPlatform;
  claudeMode?: StartupLaunchMode;
  codexMode?: StartupLaunchMode;
  opencodeMode?: StartupLaunchMode;
  claudeNativeBackend?: StartupLaunchClaudeBackend;
}

/** Per-repository overrides. `agentStyle` is the repository's Claude mode. */
export interface StartupLaunchRepositorySettings {
  defaultAgent?: AgentPlatform;
  agentStyle?: StartupLaunchMode;
  claudeNativeBackend?: StartupLaunchClaudeBackend;
}

/** Global defaults; the lowest-priority tier. */
export interface StartupLaunchGlobalSettings {
  defaultAgent?: AgentPlatform;
  claudeMode?: StartupLaunchMode;
  codexMode?: StartupLaunchMode;
  opencodeMode?: StartupLaunchMode;
  claudeNativeBackend?: StartupLaunchClaudeBackend;
}

export interface ResolvedStartupLaunch {
  agent: AgentPlatform;
  mode: StartupLaunchMode;
  /** Only meaningful when `agent` is `claude` and `mode` is `native`. */
  claudeNativeBackend: StartupLaunchClaudeBackend;
  /**
   * True when the backend's native agent service dispatches this launch itself.
   *
   * When true the renderer must leave the initial prompt and its attachments
   * alone; when false the launch needs a PTY or tmux projection and the
   * renderer still stages the images and rewrites the prompt.
   */
  dispatchedByBackend: boolean;
}

export const DEFAULT_STARTUP_LAUNCH_AGENT: AgentPlatform = DEFAULT_AGENT_PLATFORM;
/** Re-exported at its historical name; the table in `agent-settings.ts` owns it. */
export const DEFAULT_CLAUDE_MODE: StartupLaunchMode = SHIPPED_PLATFORM_MODES.claude;

/**
 * Project a legacy environment/global tier onto the shared settings shape.
 *
 * Grok takes the OpenCode mode because that is precisely what the mode ternary
 * this function replaced did with it. Cursor is SDK-only, so the shared
 * resolver forces it to native regardless of legacy mode fields.
 */
function environmentTier(
  tier: StartupLaunchEnvironmentSettings | StartupLaunchGlobalSettings | null | undefined,
): AgentSettingsTier | undefined {
  if (!tier) return undefined;
  return {
    ...(tier.defaultAgent ? { defaultAgent: tier.defaultAgent } : {}),
    platforms: {
      claude: {
        ...(tier.claudeMode ? { mode: tier.claudeMode } : {}),
        ...(tier.claudeNativeBackend ? { claudeNativeBackend: tier.claudeNativeBackend } : {}),
      },
      ...(tier.codexMode ? { codex: { mode: tier.codexMode } } : {}),
      ...(tier.opencodeMode
        ? {
            opencode: { mode: tier.opencodeMode },
            grok: { mode: tier.opencodeMode },
          }
        : {}),
    },
  };
}

/** `agentStyle` was only ever Claude's mode; nothing else read it. */
function repositoryTier(
  tier: StartupLaunchRepositorySettings | null | undefined,
): AgentSettingsTier | undefined {
  if (!tier) return undefined;
  return {
    ...(tier.defaultAgent ? { defaultAgent: tier.defaultAgent } : {}),
    platforms: {
      claude: {
        ...(tier.agentStyle ? { mode: tier.agentStyle } : {}),
        ...(tier.claudeNativeBackend ? { claudeNativeBackend: tier.claudeNativeBackend } : {}),
      },
    },
  };
}

/**
 * Resolve a launch from migrated settings. This is the form every caller should
 * reach for; {@link resolveStartupLaunch} is the legacy-shape adapter over it.
 */
export function resolveStartupLaunchFromSettings(tiers: AgentSettingsTiers): ResolvedStartupLaunch {
  const agent = resolveDefaultAgent(tiers);
  const { mode } = resolveAgentPlatformSettings(tiers, agent);
  // Always read from Claude's own block: the field is only meaningful for
  // Claude, and the legacy tiers stored it once rather than per platform.
  const { claudeNativeBackend } = resolveAgentPlatformSettings(tiers, "claude");

  return {
    agent,
    mode,
    claudeNativeBackend,
    // A tmux-backed Claude launch still needs a real tmux session, so it stays
    // with the terminal coordinator exactly like a terminal-mode launch.
    dispatchedByBackend:
      mode === "native" && !(agent === "claude" && claudeNativeBackend === "tmux"),
  };
}

export function resolveStartupLaunch(input: {
  environment?: StartupLaunchEnvironmentSettings | null;
  repository?: StartupLaunchRepositorySettings | null;
  global?: StartupLaunchGlobalSettings | null;
}): ResolvedStartupLaunch {
  return resolveStartupLaunchFromSettings({
    environment: environmentTier(input.environment),
    repository: repositoryTier(input.repository),
    global: environmentTier(input.global),
  });
}
