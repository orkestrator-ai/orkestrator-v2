import type { ComponentType } from "react";
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
  /** Open this provider's normal resume dialog as soon as its controller mounts. */
  initialResumeOpen?: boolean;
}

/**
 * The renderer-side provider boundary. Legacy controllers remain behind this
 * interface while their lifecycle code is moved into headless runtimes.
 */
export interface NativeAgentAdapter {
  platform: AgentPlatform;
  label: string;
  capabilities: NativeAgentCapabilities;
  loadController: () => Promise<ComponentType<AgentNativeTabProps>>;
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
    },
    loadController: async () => {
      const { AcpChatTab } = await import("@/components/acp");
      return function AcpNativeAgentController(props: AgentNativeTabProps) {
        return (
          <AcpChatTab
            tabId={props.tabId}
            data={props.data as AgentNativeTabProps["data"] & { platform: "cursor" | "grok" }}
            isActive={props.isActive}
            initialPrompt={props.initialPrompt}
            initialAgentModel={props.initialAgentModel}
            initialReasoningEffort={props.initialReasoningEffort}
            initialConversationMode={props.initialConversationMode}
            initialFastMode={props.initialFastMode}
          />
        );
      };
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
  },
};

export const nativeAgentAdapters: Readonly<
  Record<AgentPlatform, NativeAgentAdapter>
> = {
  claude: {
    platform: "claude",
    label: "Claude",
    capabilities: { ...richCapabilities, backgroundTasks: true },
    loadController: async () => {
      const { ClaudeChatTab } = await import("@/components/claude/ClaudeChatTab");
      return function ClaudeNativeAgentController(props: AgentNativeTabProps) {
        return <ClaudeChatTab {...props} data={props.data} />;
      };
    },
  },
  codex: {
    platform: "codex",
    label: "Codex",
    capabilities: richCapabilities,
    loadController: async () => {
      const { CodexChatTab } = await import("@/components/codex/CodexChatTab");
      return function CodexNativeAgentController(props: AgentNativeTabProps) {
        return <CodexChatTab {...props} data={props.data} />;
      };
    },
  },
  opencode: {
    platform: "opencode",
    label: "OpenCode",
    capabilities: {
      ...richCapabilities,
      composer: { ...richCapabilities.composer, speed: false },
    },
    loadController: async () => {
      const { OpenCodeChatTab } = await import("@/components/opencode");
      return function OpenCodeNativeAgentController(props: AgentNativeTabProps) {
        return <OpenCodeChatTab {...props} data={props.data} />;
      };
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
