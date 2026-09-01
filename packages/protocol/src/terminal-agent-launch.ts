import type { AgentPlatform } from "./agent-platforms.js";

export type TerminalAgentTabType = AgentPlatform | "plain";

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
}): string | null {
  const { tabType, initialPrompt, model, reasoningEffort } = options;
  const hasExplicitModel = !!model && model !== "default";

  if (tabType === "claude") {
    const args = ["claude", "--dangerously-skip-permissions"];
    if (hasExplicitModel) args.push("--model", shellArg(model));
    if (reasoningEffort) args.push("--effort", shellArg(reasoningEffort));
    if (initialPrompt) args.push(shellArg(initialPrompt));
    return args.join(" ");
  }

  if (tabType === "opencode") {
    const args = ["opencode"];
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
