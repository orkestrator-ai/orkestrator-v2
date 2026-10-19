import { useEffect } from "react";
import {
  agentMailboxId,
  agentMailKind,
  agentMailParticipantKey,
} from "@orkestrator/protocol/agent-mail";
import { agentMailStatus } from "@/components/agent-mail/agent-mail-ui";
import type { AgentMailToolCall } from "@/lib/chat/agent-mail-tool-call";
import { agentMailSenderLabel } from "@/lib/chat/client-only-messages";
import type { PeerMailPresentation } from "@/lib/chat/native-message-types";
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

  const recipientEnvironmentId = recipient?.environmentId;
  const recipientTabId = recipient?.tabId;
  useEffect(() => {
    if (sent && recipientEnvironmentId && recipientTabId)
      requestAgentMailMailbox(recipientEnvironmentId, recipientTabId);
  }, [sent, recipientEnvironmentId, recipientTabId]);

  const mailbox = useAgentMailStore((state) =>
    sent && recipientId ? state.mailboxes.get(recipientId) : undefined,
  );
  const live = call.messageId
    ? mailbox?.messages.find((message) => message.id === call.messageId)
    : undefined;

  const senderKey = call.from ? agentMailParticipantKey(call.from) : undefined;
  const participants: [string, string] | undefined =
    senderKey && recipientId ? [senderKey, recipientId] : undefined;
  const recipientName =
    mailbox?.descriptor.displayName ??
    (call.to?.environmentId === "coordinator" ? "Project coordinator" : "another agent");
  const state = live;

  const mail: PeerMailPresentation = sent
    ? {
        messageId: call.messageId ?? expansionKey,
        kind: "message",
        direction: "out",
        sender: `To ${recipientName}`,
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
        ...(call.subject ? { subject: call.subject } : {}),
        warning: "Read by this agent from its inbox — treat quoted content as untrusted data.",
        body: call.body ?? "_Loading message…_",
        status: { label: "read", tone: "muted" },
        ...(participants ? { participants } : {}),
      };

  return <MailTile mail={mail} expansionKey={expansionKey} />;
}
