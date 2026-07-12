import type { TabType } from "@/contexts";
import type { SessionType } from "@/types";

/**
 * Strip ANSI escape codes from text for clean log display
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

/**
 * Convert tab type to session type for persistence
 */
export function tabTypeToSessionType(tabType: TabType): SessionType {
  switch (tabType) {
    case "claude":
      return "claude";
    case "opencode":
      return "opencode";
    case "codex":
      return "codex";
    case "root":
      return "root";
    default:
      return "plain";
  }
}

/** Marker that indicates the workspace setup is complete */
export const ENVIRONMENT_READY_MARKER = "=== Workspace Ready ===";

/** Alternate marker formats for workspace ready detection */
export const ENVIRONMENT_READY_MARKER_ALT_TILDE = "~~~ Workspace Ready ~~~";
export const ENVIRONMENT_READY_MARKER_ALT_DASH = "--- Workspace Ready ---";
export const ENVIRONMENT_ALREADY_READY_MARKER = "Workspace already set up.";

/** Marker that appears right before "Workspace Ready" in setup scripts */
export const SETUP_COMPLETE_MARKER = "Container setup completed successfully!";

export const ENVIRONMENT_SETUP_FAILED_MARKER = "=== Workspace Setup Failed ===";

export interface ContainerSetupReadiness {
  ready: boolean;
  failed: boolean;
}

/**
 * Detect container workspace setup completion markers in terminal output.
 * Used for both live PTY output and restored terminal buffers, because setup
 * can finish while the React tree that normally receives live data is inactive.
 */
export function detectContainerSetupReadiness(text: string): ContainerSetupReadiness {
  const strippedText = stripAnsi(text);
  const failed =
    strippedText.includes(ENVIRONMENT_SETUP_FAILED_MARKER) ||
    text.includes(ENVIRONMENT_SETUP_FAILED_MARKER);
  const ready =
    failed ||
    strippedText.includes(ENVIRONMENT_READY_MARKER) ||
    text.includes(ENVIRONMENT_READY_MARKER) ||
    strippedText.includes(ENVIRONMENT_READY_MARKER_ALT_TILDE) ||
    strippedText.includes(ENVIRONMENT_READY_MARKER_ALT_DASH) ||
    strippedText.includes(ENVIRONMENT_ALREADY_READY_MARKER) ||
    strippedText.includes(SETUP_COMPLETE_MARKER);

  return { ready, failed };
}

/** OSC identifier used for invisible setup-complete signalling via xterm.js */
export const SETUP_DONE_OSC_ID = 9999;

/** OSC payload emitted on successful setup completion */
export const SETUP_DONE_OSC_DATA = "setup_done";

/** OSC payload emitted when setup commands exit non-zero */
export const SETUP_FAILED_OSC_DATA = "setup_failed";

/**
 * Shell commands that emit an invisible OSC escape sequence to signal setup
 * completion. xterm.js consumes OSC sequences without rendering them, so the
 * marker is invisible. The shell echo of the printf command shows literal text,
 * not escape bytes, so it cannot trigger the OSC handler — only the actual
 * execution does.
 *
 * Both success and failure variants exist so completion is always detected even
 * when a setup step exits non-zero. Persistence is still gated on the success
 * variant.
 */
export const SETUP_DONE_PRINTF_CMD = `printf '\\033]${SETUP_DONE_OSC_ID};${SETUP_DONE_OSC_DATA}\\007'`;
export const SETUP_FAILED_PRINTF_CMD = `printf '\\033]${SETUP_DONE_OSC_ID};${SETUP_FAILED_OSC_DATA}\\007'`;

/** Patterns that indicate a shell prompt is ready */
export const SHELL_PROMPT_PATTERNS: (string | RegExp)[] = [
  "=== Container Ready ===",
  /➜\s+\w+\s+git:\(/,
  /➜\s+workspace/,
];
