import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  nativeAgentCapabilities,
  type NativeAgentCapabilities,
  type NativeAgentTabData,
} from "@orkestrator/protocol/native-agent";

export interface AgentNativeTabProps {
  tabId: string;
  data: NativeAgentTabData;
  isActive: boolean;
  ownsGlobalShortcuts?: boolean;
  initialPrompt?: string;
  isReviewTab?: boolean;
  initialAgentModel?: string;
  initialReasoningEffort?: string;
  initialConversationMode?: "build" | "plan";
  initialFastMode?: boolean;
  initialExecutionProfileId?: string;
  agentHandoffId?: string;
  consumedAgentHandoffId?: string;
  refreshRequestId?: number;
  /** Open the shared resume dialog as soon as the controller mounts. */
  initialResumeOpen?: boolean;
}

/** Provider metadata consumed by the one shared native-agent controller. */
export interface NativeAgentAdapter {
  platform: AgentPlatform;
  label: string;
  capabilities: NativeAgentCapabilities;
}

/**
 * Only the display label is renderer-owned. Capabilities come from the shared
 * protocol table so the composer's enqueue decision cannot disagree with the
 * backend projection that has to surface the queue it produces.
 */
function adapter(platform: AgentPlatform, label: string): NativeAgentAdapter {
  return { platform, label, capabilities: nativeAgentCapabilities(platform) };
}

export const nativeAgentAdapters: Readonly<Record<AgentPlatform, NativeAgentAdapter>> = {
  claude: adapter("claude", "Claude"),
  codex: adapter("codex", "Codex"),
  opencode: adapter("opencode", "OpenCode"),
  cursor: adapter("cursor", "Cursor Agent"),
  grok: adapter("grok", "Grok Build"),
  pi: adapter("pi", "Pi"),
};

export function getNativeAgentAdapter(platform: AgentPlatform): NativeAgentAdapter {
  return nativeAgentAdapters[platform];
}

/**
 * Registry lookup for a platform that has not been narrowed yet — a persisted
 * pane record, or any other value that reaches the renderer as a plain string.
 * `hasOwnProperty` keeps `"constructor"` and friends from resolving through
 * `Object.prototype` to something that is not an adapter.
 */
export function findNativeAgentAdapter(platform: string): NativeAgentAdapter | undefined {
  return Object.prototype.hasOwnProperty.call(nativeAgentAdapters, platform)
    ? nativeAgentAdapters[platform as AgentPlatform]
    : undefined;
}
