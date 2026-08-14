import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  NativeAgentCapabilities,
  NativeAgentTabData,
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

function acpAdapter(
  provider: "cursor" | "grok",
  label: string,
): NativeAgentAdapter {
  return {
    platform: provider,
    label,
    capabilities: {
      attachments: { files: false, images: false },
      queue: false,
      resume: false,
      fork: false,
      slashCommands: false,
      backgroundTasks: false,
      composer: {
        provider: true,
        model: true,
        reasoning: true,
        speed: true,
        mode: true,
      },
      actions: {},
    },
  };
}

const richCapabilities: NativeAgentCapabilities = {
  attachments: { files: true, images: true },
  queue: true,
  resume: true,
  fork: true,
  slashCommands: true,
  backgroundTasks: false,
  composer: {
    provider: true,
    model: true,
    reasoning: true,
    speed: true,
    mode: true,
    executionProfile: false,
    localSettings: false,
    promptSuggestions: false,
  },
  actions: { compact: true },
};

export const nativeAgentAdapters: Readonly<
  Record<AgentPlatform, NativeAgentAdapter>
> = {
  claude: {
    platform: "claude",
    label: "Claude",
    capabilities: {
      ...richCapabilities,
      backgroundTasks: true,
      composer: {
        ...richCapabilities.composer,
        executionProfile: true,
        localSettings: true,
        promptSuggestions: true,
      },
      actions: { compact: true, rewindFiles: true },
    },
  },
  codex: {
    platform: "codex",
    label: "Codex",
    capabilities: {
      ...richCapabilities,
      actions: { compact: true, steer: true, review: true },
    },
  },
  opencode: {
    platform: "opencode",
    label: "OpenCode",
    capabilities: {
      ...richCapabilities,
      composer: {
        ...richCapabilities.composer,
        speed: false,
        executionProfile: true,
      },
      actions: { compact: true, undo: true, redo: true, share: true },
    },
  },
  cursor: acpAdapter("cursor", "Cursor Agent"),
  grok: acpAdapter("grok", "Grok Build"),
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
export function findNativeAgentAdapter(
  platform: string,
): NativeAgentAdapter | undefined {
  return Object.prototype.hasOwnProperty.call(nativeAgentAdapters, platform)
    ? nativeAgentAdapters[platform as AgentPlatform]
    : undefined;
}
