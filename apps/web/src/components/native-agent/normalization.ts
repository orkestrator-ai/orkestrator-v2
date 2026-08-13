import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { AcpMessage } from "@/lib/acp-client";
import type { ClaudeMessage } from "@/lib/claude-client";
import type { CodexMessage } from "@/lib/codex-client";
import type { OpenCodeMessage } from "@/lib/opencode-client";
import {
  normalizeAcpNativeMessage,
  normalizeClaudeMessagesForDisplay,
  normalizeCodexNativeMessage,
  normalizeOpenCodeNativeMessage,
} from "@/lib/chat/native-message-adapters";
import type { NativeMessage } from "@/lib/chat/native-message-types";

export type NativeAgentSourceMessages = {
  claude: readonly ClaudeMessage[];
  codex: readonly CodexMessage[];
  opencode: readonly OpenCodeMessage[];
  cursor: readonly AcpMessage[];
  grok: readonly AcpMessage[];
};

/**
 * The sole provider-message normalization entry point used by native tabs.
 * Provider payloads do not cross this boundary into shared presentation.
 */
export function normalizeNativeAgentMessages<P extends AgentPlatform>(
  platform: P,
  messages: NativeAgentSourceMessages[P],
): NativeMessage[] {
  switch (platform) {
    case "claude":
      return normalizeClaudeMessagesForDisplay(messages as ClaudeMessage[]);
    case "codex":
      return (messages as readonly CodexMessage[]).map(normalizeCodexNativeMessage);
    case "opencode":
      return (messages as readonly OpenCodeMessage[]).map(normalizeOpenCodeNativeMessage);
    case "cursor":
    case "grok":
      return (messages as readonly AcpMessage[]).map(normalizeAcpNativeMessage);
  }
}

