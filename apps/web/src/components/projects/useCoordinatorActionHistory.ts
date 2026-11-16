import { DEFAULT_NATIVE_AGENT_LIVE_WINDOW } from "@orkestrator/protocol/native-agent";
import { createSessionKey } from "@/lib/utils";
import { useEffect, useState } from "react";
import { backendForScope } from "@/lib/backend/scope-backend";
import { useNodeScope } from "@/lib/node-scope/providers";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import { recoverActionHistory } from "./coordinator-action-history";

export const ACTION_HISTORY_RETRY_MS = 1_000;

export function useCoordinatorActionHistory(
  enabled: boolean,
  environmentId: string,
  tabId: string,
  agent: AgentPlatform,
  sessionId?: string,
) {
  const scope = useNodeScope();
  const [result, setResult] = useState<{ key: string; messages: NativeMessage[] }>();
  const key = `${environmentId}:${tabId}:${agent}:${sessionId}`;
  useEffect(() => {
    if (!enabled || !sessionId) return;
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const identity = {
      environmentId,
      agent,
      logicalSessionKey: createSessionKey(environmentId, tabId),
    };
    const backend = backendForScope(scope);
    const recover = async () => {
      // The transcript view names the direct cursor its older rows page from.
      const snapshot = await backend.getNativeAgentTranscriptUpdate<NativeMessage>({
        ...identity,
        viewVersion: 1,
        forceSnapshot: true,
        liveWindow: DEFAULT_NATIVE_AGENT_LIVE_WINDOW,
      });
      if (stopped || snapshot.status !== "snapshot") return;
      const view = snapshot.value;
      if (!view.historyCursor && !view.historyComplete) {
        // A restored provider can return a preview while it hydrates. This
        // independent reader must retry even when the chat is not mounted.
        retryTimer = setTimeout(run, ACTION_HISTORY_RETRY_MS);
        return;
      }
      const messages = await recoverActionHistory(
        view.messages,
        view.historyCursor,
        view.historyEpoch,
        (before) =>
          backend.getNativeAgentMessagePage<NativeMessage>({
            ...identity,
            syncVersion: 1,
            before,
            limit: 200,
            targetBytes: 512 * 1024,
          }),
        () => stopped,
      );
      if (!stopped) setResult({ key, messages });
    };
    function run() {
      retryTimer = undefined;
      if (stopped) return;
      void recover().catch(() => {
        /* An unavailable index never replaces live action evidence. */
      });
    }
    run();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
    };
  }, [enabled, environmentId, tabId, agent, sessionId, scope, key]);
  return result?.key === key ? result.messages : undefined;
}
