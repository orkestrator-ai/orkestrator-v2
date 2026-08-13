import { useMemo, type ComponentType } from "react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  NativeAgentCapabilities,
  NativeAgentTabData,
} from "@orkestrator/protocol/native-agent";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import { toLegacyNativeAgentData } from "@/types/paneLayout";
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

/**
 * Controllers still take their own legacy pane record, and several of them
 * spread that record straight back into the pane layout when forking a tab.
 * Handing them the canonical identity unchanged would carry `platform` into
 * the legacy field, where the pane-layout merge strips it again — the same tab
 * would then serialize two different ways depending on whether a write
 * conflict occurred. Project once, here, so the value a controller receives is
 * exactly the shape its props declare.
 *
 * Memoized on `data`, which is the tab's stored identity object: the
 * controllers key `useCallback`/`useEffect` off this prop, and a fresh object
 * per render would invalidate the transcript memoization on every tick.
 */
function useLegacyNativeAgentData(data: NativeAgentTabData) {
  return useMemo(() => toLegacyNativeAgentData(data), [data]);
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
    },
    normalizeMessages: normalizer(provider),
    loadController: async () => {
      const { AcpChatTab } = await import("@/components/acp");
      return function AcpNativeAgentController(props: NativeAgentTabProps) {
        const legacyData = useLegacyNativeAgentData(props.data);
        const data = useMemo(
          () => ({ ...legacyData, provider }),
          [legacyData],
        );
        return (
          <AcpChatTab
            tabId={props.tabId}
            data={data}
            isActive={props.isActive}
            initialPrompt={props.initialPrompt}
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
      return function ClaudeNativeAgentController(props: NativeAgentTabProps) {
        const data = useLegacyNativeAgentData(props.data);
        return <ClaudeChatTab {...props} data={data} />;
      };
    },
  },
  codex: {
    platform: "codex",
    label: "Codex",
    capabilities: richCapabilities,
    normalizeMessages: normalizer("codex"),
    loadController: async () => {
      const { CodexChatTab } = await import("@/components/codex/CodexChatTab");
      return function CodexNativeAgentController(props: NativeAgentTabProps) {
        const data = useLegacyNativeAgentData(props.data);
        return <CodexChatTab {...props} data={data} />;
      };
    },
  },
  opencode: {
    platform: "opencode",
    label: "OpenCode",
    capabilities: richCapabilities,
    normalizeMessages: normalizer("opencode"),
    loadController: async () => {
      const { OpenCodeChatTab } = await import("@/components/opencode");
      return function OpenCodeNativeAgentController(props: NativeAgentTabProps) {
        const data = useLegacyNativeAgentData(props.data);
        return <OpenCodeChatTab {...props} data={data} />;
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
