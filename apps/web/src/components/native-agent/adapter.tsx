import type { ComponentType } from "react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  NativeAgentCapabilities,
  NativeAgentTabData,
} from "@orkestrator/protocol/native-agent";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import { normalizeNativeAgentMessages } from "./normalization";

export interface NativeAgentTabProps {
  tabId: string;
  data: NativeAgentTabData;
  isActive: boolean;
  ownsGlobalShortcuts?: boolean;
  initialPrompt?: string;
  isReviewTab?: boolean;
  initialAgentModel?: string;
  initialReasoningEffort?: string;
  agentHandoffId?: string;
  consumedAgentHandoffId?: string;
  refreshRequestId?: number;
}

/**
 * The renderer-side provider boundary. Legacy controllers remain behind this
 * interface while their lifecycle code is moved into headless runtimes.
 */
export interface NativeAgentAdapter {
  platform: AgentPlatform;
  label: string;
  capabilities: NativeAgentCapabilities;
  normalizeMessages: (messages: readonly unknown[]) => NativeMessage[];
  loadController: () => Promise<ComponentType<NativeAgentTabProps>>;
}

function normalizer(platform: AgentPlatform) {
  return (messages: readonly unknown[]): NativeMessage[] =>
    normalizeNativeAgentMessages(platform, messages as never);
}

const richCapabilities: NativeAgentCapabilities = {
  attachments: { files: true, images: true },
  queue: true,
  resume: true,
  fork: true,
  slashCommands: true,
  backgroundTasks: false,
};

export const nativeAgentAdapters: Readonly<
  Record<AgentPlatform, NativeAgentAdapter>
> = {
  claude: {
    platform: "claude",
    label: "Claude",
    capabilities: { ...richCapabilities, backgroundTasks: true },
    normalizeMessages: normalizer("claude"),
    loadController: async () => {
      const { ClaudeChatTab } = await import("@/components/claude/ClaudeChatTab");
      return ((props: NativeAgentTabProps) => (
        <ClaudeChatTab
          {...props}
          data={props.data}
          ownsGlobalShortcuts={props.ownsGlobalShortcuts}
        />
      ));
    },
  },
  codex: {
    platform: "codex",
    label: "Codex",
    capabilities: richCapabilities,
    normalizeMessages: normalizer("codex"),
    loadController: async () => {
      const { CodexChatTab } = await import("@/components/codex/CodexChatTab");
      return ((props: NativeAgentTabProps) => (
        <CodexChatTab
          {...props}
          data={props.data}
          ownsGlobalShortcuts={props.ownsGlobalShortcuts}
        />
      ));
    },
  },
  opencode: {
    platform: "opencode",
    label: "OpenCode",
    capabilities: richCapabilities,
    normalizeMessages: normalizer("opencode"),
    loadController: async () => {
      const { OpenCodeChatTab } = await import("@/components/opencode");
      return ((props: NativeAgentTabProps) => (
        <OpenCodeChatTab
          {...props}
          data={props.data}
          ownsGlobalShortcuts={props.ownsGlobalShortcuts}
        />
      ));
    },
  },
  cursor: {
    platform: "cursor",
    label: "Cursor Agent",
    capabilities: {
      attachments: { files: false, images: false },
      queue: false,
      resume: false,
      fork: false,
      slashCommands: false,
      backgroundTasks: false,
    },
    normalizeMessages: normalizer("cursor"),
    loadController: async () => {
      const { AcpChatTab } = await import("@/components/acp");
      return ((props: NativeAgentTabProps) => (
        <AcpChatTab
          tabId={props.tabId}
          data={{ ...props.data, provider: "cursor" }}
          isActive={props.isActive}
          initialPrompt={props.initialPrompt}
        />
      ));
    },
  },
  grok: {
    platform: "grok",
    label: "Grok Build",
    capabilities: {
      attachments: { files: false, images: false },
      queue: false,
      resume: false,
      fork: false,
      slashCommands: false,
      backgroundTasks: false,
    },
    normalizeMessages: normalizer("grok"),
    loadController: async () => {
      const { AcpChatTab } = await import("@/components/acp");
      return ((props: NativeAgentTabProps) => (
        <AcpChatTab
          tabId={props.tabId}
          data={{ ...props.data, provider: "grok" }}
          isActive={props.isActive}
          initialPrompt={props.initialPrompt}
        />
      ));
    },
  },
};

export function getNativeAgentAdapter(platform: AgentPlatform): NativeAgentAdapter {
  return nativeAgentAdapters[platform];
}
