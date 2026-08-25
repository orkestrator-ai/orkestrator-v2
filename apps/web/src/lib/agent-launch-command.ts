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

  if (tabType === "pi") {
    const args = ["pi"];
    // Pi identifies a model by provider *and* id, and takes them as separate
    // flags. The composer's flat `provider/model` id is split back apart here
    // rather than being passed whole, which `--model` would read as a model
    // name containing a slash and fail to resolve.
    if (hasExplicitModel) {
      const separator = model.indexOf("/");
      if (separator > 0) {
        args.push("--provider", shellArg(model.slice(0, separator)));
        args.push("--model", shellArg(model.slice(separator + 1)));
      } else {
        args.push("--model", shellArg(model));
      }
    }
    // Pi calls the reasoning axis "thinking", and `off` is one of its levels.
    if (reasoningEffort) args.push("--thinking", shellArg(reasoningEffort));
    if (initialPrompt) args.push(shellArg(initialPrompt));
    return args.join(" ");
  }

  if (tabType === "cursor") return "cursor-agent";
  if (tabType === "grok") return "grok";

  return null;
}
