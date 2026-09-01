import { buildTerminalAgentLaunchCommand } from "@orkestrator/protocol/terminal-agent-launch";
import type { TabType } from "@/contexts";

export function buildAgentLaunchCommand(options: {
  tabType: TabType;
  initialPrompt?: string;
  model?: string;
  reasoningEffort?: string;
}): string | null {
  const { tabType, initialPrompt, model, reasoningEffort } = options;
  if (
    tabType !== "plain" &&
    tabType !== "claude" &&
    tabType !== "codex" &&
    tabType !== "cursor" &&
    tabType !== "grok" &&
    tabType !== "opencode" &&
    tabType !== "pi"
  ) {
    return null;
  }
  return buildTerminalAgentLaunchCommand({ tabType, initialPrompt, model, reasoningEffort });
}
