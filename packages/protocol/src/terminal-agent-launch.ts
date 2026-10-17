import type { AgentPlatform } from "./agent-platforms.js";
import { claudeCliReasoningSelection } from "./claude-model-catalog.js";

export type TerminalAgentTabType = AgentPlatform | "plain";

/**
 * Environment every OpenCode process Orkestrator starts must carry.
 *
 * OpenCode 1.19 checks for updates from the TUI and offers `/update`, which can
 * install OpenCode 2 over the pinned 1.x binary (in a container that binary
 * sits in `~/.opencode/bin`, which OpenCode treats as a curl install). OpenCode
 * 2's server API is incompatible with the v2 SDK client the backend uses, so a
 * one-click upgrade would break every native OpenCode session. With this set
 * the TUI never checks or announces an update; `/update` stays reachable from
 * the command palette as a deliberate user action.
 */
export const OPENCODE_PINNED_RUNTIME_ENV = Object.freeze({
  OPENCODE_DISABLE_AUTOUPDATE: "1",
});

/**
 * Environment for the managed, pinned `claude` Orkestrator starts on the host.
 *
 * Claude Code checks for and installs updates in the background. The managed
 * binary is the version the Agent SDK pin was qualified with, and a newer one
 * belongs to the next Orkestrator release, so its background updater is off.
 * `DISABLE_AUTOUPDATER` also stops plugin auto-updates; `FORCE_AUTOUPDATE_PLUGINS`
 * keeps those, which belong to the user. A `claude` found on PATH is the
 * user's own install and is left to update itself.
 */
export const CLAUDE_PINNED_RUNTIME_ENV = Object.freeze({
  DISABLE_AUTOUPDATER: "1",
  FORCE_AUTOUPDATE_PLUGINS: "1",
});

function shellArg(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");
  return `"${escaped}"`;
}

/** Build the exact one-shot command used to start an agent inside a PTY. */
export function buildTerminalAgentLaunchCommand(options: {
  tabType: TerminalAgentTabType;
  initialPrompt?: string;
  model?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
}): string | null {
  const { tabType, initialPrompt, model, reasoningEffort, fastMode } = options;
  const hasExplicitModel = !!model && model !== "default";

  if (tabType === "claude") {
    const args = ["claude", "--dangerously-skip-permissions"];
    const claudeReasoning = claudeCliReasoningSelection(reasoningEffort);
    if (hasExplicitModel) args.push("--model", shellArg(model));
    if (claudeReasoning.effort) {
      args.push("--effort", shellArg(claudeReasoning.effort));
    }
    if (typeof fastMode === "boolean" || claudeReasoning.ultracode) {
      args.push(
        "--settings",
        shellArg(
          JSON.stringify({
            ...(typeof fastMode === "boolean" ? { fastMode } : {}),
            ...(claudeReasoning.ultracode ? { ultracode: true } : {}),
          }),
        ),
      );
    }
    if (initialPrompt) args.push(shellArg(initialPrompt));
    return args.join(" ");
  }

  if (tabType === "opencode") {
    // The PTY is a shared interactive shell, so the variable rides on the
    // command itself rather than on the terminal's environment.
    const args = [
      ...Object.entries(OPENCODE_PINNED_RUNTIME_ENV).map(([name, value]) => `${name}=${value}`),
      "opencode",
    ];
    if (hasExplicitModel) args.push("--model", shellArg(model));
    if (initialPrompt) args.push("--prompt", shellArg(initialPrompt));
    return args.join(" ");
  }

  if (tabType === "codex") {
    const args = ["codex"];
    if (hasExplicitModel) args.push("--model", shellArg(model));
    if (reasoningEffort) {
      args.push("--config", shellArg(`model_reasoning_effort="${reasoningEffort}"`));
    }
    if (typeof fastMode === "boolean") {
      args.push("--config", shellArg(`service_tier="${fastMode ? "priority" : "default"}"`));
    }
    if (initialPrompt) args.push(shellArg(initialPrompt));
    return args.join(" ");
  }

  if (tabType === "pi") {
    const args = ["pi"];
    if (hasExplicitModel) {
      const separator = model.indexOf("/");
      if (separator > 0) {
        args.push("--provider", shellArg(model.slice(0, separator)));
        args.push("--model", shellArg(model.slice(separator + 1)));
      } else {
        args.push("--model", shellArg(model));
      }
    }
    if (reasoningEffort && reasoningEffort !== "default") {
      args.push("--thinking", shellArg(reasoningEffort));
    }
    if (initialPrompt) args.push(shellArg(initialPrompt));
    return args.join(" ");
  }

  if (tabType === "cursor") return null;
  if (tabType === "grok") return "grok";
  return null;
}
