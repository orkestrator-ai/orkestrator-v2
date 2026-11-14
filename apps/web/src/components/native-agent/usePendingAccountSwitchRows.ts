import { useEffect, useMemo } from "react";
import { agentMailboxId } from "@orkestrator/protocol/agent-mail";
import { accountSwitchRowsFromMailbox } from "@/lib/chat/account-switch-rows";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import { useNodeScope } from "@/lib/node-scope/providers";
import { requestAgentMailMailbox, useAgentMailStore } from "@/stores/agentMailStore";

const NO_ROWS: NativeMessage[] = [];

/**
 * Account-switch notices waiting in this tab's mailbox, as transcript rows.
 *
 * Only coordinators receive them, so only a coordinator tab asks for its
 * mailbox. The mailbox snapshot is the backend's and is refreshed when the
 * mail summary moves, so a new notice appears without a turn and a reload
 * shows it again.
 */
export function usePendingAccountSwitchRows(
  environmentId: string,
  tabId: string,
  enabled: boolean,
): NativeMessage[] {
  const scope = useNodeScope();
  useEffect(() => {
    if (enabled) requestAgentMailMailbox(environmentId, tabId, scope);
  }, [enabled, environmentId, tabId, scope]);
  const messages = useAgentMailStore((state) =>
    enabled ? state.mailboxes.get(agentMailboxId(environmentId, tabId))?.messages : undefined,
  );
  return useMemo(() => {
    const rows = accountSwitchRowsFromMailbox(messages);
    return rows.length ? rows : NO_ROWS;
  }, [messages]);
}
