import type { TabType } from "@/contexts";

function shellArg(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");
  return `"${escaped}"`;
}

export function buildAgentLaunchCommand(options: {
  tabType: TabType;
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

  return null;
}
