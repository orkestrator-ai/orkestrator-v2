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

export const DEFAULT_STARTUP_LAUNCH_AGENT: AgentPlatform = "claude";
export const DEFAULT_CLAUDE_MODE: StartupLaunchMode = "native";

/**
 * Non-Claude agents remain conservative when their mode is absent.
 *
 * Claude has its own shipped native default above. Codex and OpenCode keep the
 * terminal fallback here so this resolver does not silently expand their launch
 * ownership when a partial or legacy config reaches it.
 */
const DEFAULT_STARTUP_LAUNCH_MODE: StartupLaunchMode = "terminal";
const DEFAULT_STARTUP_LAUNCH_CLAUDE_BACKEND: StartupLaunchClaudeBackend = "sdk";

export function resolveStartupLaunch(input: {
  environment?: StartupLaunchEnvironmentSettings | null;
  repository?: StartupLaunchRepositorySettings | null;
  global?: StartupLaunchGlobalSettings | null;
}): ResolvedStartupLaunch {
  const { environment, repository, global } = input;

  const agent: AgentPlatform =
    environment?.defaultAgent
    ?? repository?.defaultAgent
    ?? global?.defaultAgent
    ?? DEFAULT_STARTUP_LAUNCH_AGENT;

  // Only Claude and Codex carry their own mode. Every other platform is
  // launched through the OpenCode mode, which is what the backend has always
  // done — mirrored here rather than corrected, because a launch the two sides
  // disagree about is worse than one they agree is unusual.
  const mode: StartupLaunchMode =
    agent === "claude"
      ? (environment?.claudeMode
        ?? repository?.agentStyle
        ?? global?.claudeMode
        ?? DEFAULT_CLAUDE_MODE)
      : agent === "codex"
        ? (environment?.codexMode
          ?? global?.codexMode
          ?? DEFAULT_STARTUP_LAUNCH_MODE)
        : (environment?.opencodeMode
          ?? global?.opencodeMode
          ?? DEFAULT_STARTUP_LAUNCH_MODE);

  const claudeNativeBackend: StartupLaunchClaudeBackend =
    environment?.claudeNativeBackend
    ?? repository?.claudeNativeBackend
    ?? global?.claudeNativeBackend
    ?? DEFAULT_STARTUP_LAUNCH_CLAUDE_BACKEND;

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
