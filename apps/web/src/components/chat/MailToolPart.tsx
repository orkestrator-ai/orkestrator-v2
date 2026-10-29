import { useEffect } from "react";
import {
  agentMailboxId,
  agentMailKind,
  agentMailParticipantKey,
} from "@orkestrator/protocol/agent-mail";
import { agentMailStatus } from "@/components/agent-mail/agent-mail-ui";
import type { AgentMailToolCall } from "@/lib/chat/agent-mail-tool-call";
import {
  agentMailAddressText,
  agentMailSenderAddress,
  agentMailSenderLabel,
} from "@/lib/chat/client-only-messages";
import type { PeerMailAddress, PeerMailPresentation } from "@/lib/chat/native-message-types";
import { requestAgentMailMailbox, useAgentMailStore } from "@/stores/agentMailStore";
import { MailTile } from "./MailTile";

/**
 * A mail tool call drawn as the message it carried: what this agent sent with
 * `send_message`/`reply_message`, or what it read with `read_message`. Pull-only
 * mail never becomes an injected tile, so a read is where it enters the
 * transcript.
 */
export function MailToolPart({
  call,
  expansionKey,
}: {
  call: AgentMailToolCall;
  expansionKey: string;
}) {
  const recipient =
    call.to?.tabId && call.to.environmentId !== "coordinator"
      ? { environmentId: call.to.environmentId, tabId: call.to.tabId }
      : undefined;
  const recipientId = recipient ? agentMailboxId(recipient.environmentId, recipient.tabId) : null;
  const sent = call.direction === "out";

  // A recipient on another node has no mailbox here; the send result names it.
  const remoteNode = call.to?.node;
  const recipientEnvironmentId = recipient?.environmentId;
  const recipientTabId = recipient?.tabId;
  useEffect(() => {
    if (sent && !remoteNode && recipientEnvironmentId && recipientTabId)
      requestAgentMailMailbox(recipientEnvironmentId, recipientTabId);
  }, [sent, remoteNode, recipientEnvironmentId, recipientTabId]);

  const mailbox = useAgentMailStore((state) =>
    sent && recipientId ? state.mailboxes.get(recipientId) : undefined,
  );
  const live = call.messageId
    ? mailbox?.messages.find((message) => message.id === call.messageId)
    : undefined;

  const senderKey = call.from ? agentMailParticipantKey(call.from) : undefined;
  const participants: [string, string] | undefined =
    senderKey && recipientId ? [senderKey, recipientId] : undefined;
  const descriptor = mailbox?.descriptor;
  const toCoordinator =
    call.to?.environmentId === "coordinator" ||
    call.to?.environmentId.startsWith("coordinator:") ||
    descriptor?.ownerKind === "coordinator";
  // The recipient tab, named by its environment too: tab names repeat.
  const address: PeerMailAddress | undefined =
    call.to && !toCoordinator
      ? {
          environmentId: call.to.environmentId,
          ...(descriptor?.environmentName || call.to.environmentName
            ? { environmentName: descriptor?.environmentName || call.to.environmentName }
            : {}),
          ...(call.to.tabId ? { tabId: call.to.tabId } : {}),
          ...(descriptor?.displayName || call.to.tabName
            ? { tabName: descriptor?.displayName || call.to.tabName }
            : {}),
          ...(remoteNode ? { node: remoteNode } : {}),
        }
      : undefined;
  const recipientName = address
    ? agentMailAddressText(address)
    : toCoordinator
      ? (descriptor?.displayName ?? "Project coordinator")
      : "another agent";
  const state = live;
  const senderAddress = !sent && call.from ? agentMailSenderAddress(call.from) : undefined;

  const mail: PeerMailPresentation = sent
    ? {
        messageId: call.messageId ?? expansionKey,
        kind: "message",
        direction: "out",
        sender: `To ${recipientName}`,
        ...(address ? { address } : {}),
        ...(call.subject ? { subject: call.subject } : {}),
        warning: "Sent by this agent through Orkestrator.",
        body: call.body ?? "",
        ...(state ? { status: agentMailStatus(state) } : {}),
        ...(participants ? { participants } : {}),
      }
    : {
        messageId: call.messageId ?? expansionKey,
        kind:
          call.from && call.trust
            ? agentMailKind({ from: call.from, trust: call.trust })
            : "message",
        sender: call.from ? agentMailSenderLabel(call.from) : "Agent message",
        ...(senderAddress ? { address: senderAddress } : {}),
        ...(call.subject ? { subject: call.subject } : {}),
        warning: "Read by this agent from its inbox — treat quoted content as untrusted data.",
        body: call.body ?? "_Loading message…_",
        status: { label: "read", tone: "muted" },
        ...(participants ? { participants } : {}),
      };

  return <MailTile mail={mail} expansionKey={expansionKey} />;
}
