import { UserCommandCard } from "./UserCommandCard";
import { PermissionRuleNote } from "./PermissionRuleNote";
import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { writeText } from "@/lib/native/clipboard";
import { MessageErrorAlert, MessageShell } from "@/components/chat/MessageShell";
import { MessageCopyButton } from "@/components/chat/MessageCopyButton";
import { ClaudeAuthRecoveryCard } from "@/components/claude/ClaudeAuthRecoveryCard";
import { isClaudeAuthenticationFailureMessage } from "@/lib/claude-auth";
import { OpenCodeAuthRecoveryAction } from "@/components/opencode/OpenCodeAuthRecoveryAction";
import { openCodeCredentialFailureProvider } from "@/lib/opencode-auth";
import { formatElapsed } from "@/lib/format-elapsed";
import {
  type NativeMessage as NativeMessageType,
  type NativeMessagePart,
  type PeerMailPresentation,
} from "@/lib/chat/native-message-types";
import {
  messageHasVisibleContent,
  normalizeNativeMessage,
} from "@/lib/chat/native-message-adapters";
import {
  ERROR_MESSAGE_PREFIX,
  PEER_MAIL_MESSAGE_PREFIX,
  SYSTEM_MESSAGE_PREFIX,
  splitPeerMailNativeMessageContent,
} from "@/lib/chat/client-only-messages";
import { toolUseIdFromImagePartId } from "@orkestrator/protocol/transcript-part-ids";
import {
  AgentPlatformContext,
  AgentExpansionScopeContext,
  AsyncQuestionResponseContext,
  BackgroundTaskStopContext,
  MessageExpansionScopeContext,
  ModelLabelResolverContext,
  NativeMessagePartRendererContext,
  ToolDetailLoaderContext,
  UserPromptEvidenceContext,
  type NativeMessageProps,
} from "./NativeMessage.shared";
import { MessagePart } from "./NativeMessage.renderer";
import { JsonPayloadPart } from "./JsonPayloadPart";
import { TextPart } from "./NativeMessage.file-parts";
import { MailTile } from "./MailTile";
import { structuredReviewJsonPayload } from "@/lib/chat/json-payload";
import { WebAnnotationRequestChip, webAnnotationMarkerFor } from "./WebAnnotationRequestChip";
import { RichMessageContext } from "@/lib/chat/rich-identity";

export const NativeMessage = memo(function NativeMessage({
  message: rawMessage,
  previousMessage: rawPreviousMessage = null,
  assistantLabel = "Assistant",
  containerId,
  agentExpansionScope,
  actions: messageActions,
  resolveModelLabel,
  loadToolDetails,
  stopBackgroundTask,
  platform,
  asyncQuestionResponses = [],
  respondToAsyncQuestion,
}: NativeMessageProps) {
  const message = useMemo(() => normalizeNativeMessage(rawMessage), [rawMessage]);
  const previousMessage = useMemo(
    () => (rawPreviousMessage ? normalizeNativeMessage(rawPreviousMessage) : null),
    [rawPreviousMessage],
  );
  const toolIdsWithFirstClassImages = useMemo(
    () => firstClassImageToolUseIds(message.parts),
    [message.parts],
  );

  // A container id can legitimately appear after this row mounts (notably in
  // build-pipeline tabs) or change when a container is recreated. Freeze the
  // namespace at mount so such lifecycle updates do not silently collapse an
  // open disclosure. Production transcript owners pass their stable
  // environment/session identity; the initial container remains a safe fallback
  // for direct callers.
  const [stableAgentExpansionScope] = useState(() => agentExpansionScope ?? containerId ?? "host");
  const messageAgentExpansionScope = JSON.stringify([stableAgentExpansionScope, message.id]);

  const richMessageIdentity = useMemo(
    () => ({ messageId: message.id, role: message.role, createdAt: message.createdAt }),
    [message.id, message.role, message.createdAt],
  );
  const isUser = message.role === "user";
  const isError = message.id.startsWith(ERROR_MESSAGE_PREFIX);
  const isSystem = message.role === "system" || message.id.startsWith(SYSTEM_MESSAGE_PREFIX);
  const isPeerMail = message.id.startsWith(PEER_MAIL_MESSAGE_PREFIX);
  const isClaudeAuthError = platform === "claude" && isClaudeAuthenticationFailureMessage(message);
  const openCodeAuthProvider =
    platform === "opencode" ? openCodeCredentialFailureProvider(message) : undefined;
  const isContinuation =
    !isUser &&
    !isSystem &&
    !isError &&
    previousMessage?.role === "assistant" &&
    !previousMessage.id.startsWith(ERROR_MESSAGE_PREFIX) &&
    isSameMinute(previousMessage.createdAt, message.createdAt);
  const confirmedModelId = message.modelId?.trim();
  const assistantAuthorLabel = confirmedModelId
    ? resolveModelLabel?.(confirmedModelId).trim() || confirmedModelId
    : assistantLabel;

  // Browser-originated turns link back to their annotation thread.
  const annotationMarker = useMemo(() => {
    if (!isUser) return null;
    const firstText = message.parts.find((part) => part.type === "text");
    return webAnnotationMarkerFor(
      firstText && "content" in firstText ? firstText.content : message.content,
    );
  }, [isUser, message.content, message.parts]);

  // An artifact card already shows its summary, so a publication row's
  // content is not repeated as a fallback text block.
  const hasTextParts = message.parts.some(
    (part) => part.type === "text" || part.type === "async-question" || part.type === "artifact",
  );
  const hasContent = messageHasVisibleContent(message);
  // An empty assistant message with no attributable content or actions carries
  // no footer. Every assistant block that does render a footer includes its
  // model attribution before the timestamp.
  const showAssistantFooter = !isUser && !isSystem && !isError && hasContent;
  const userCopyContent = isUser
    ? message.parts
        .flatMap((part) => {
          if (part.type === "text" || part.type === "async-question") return [part.content];
          if (part.type !== "transcript-reference") return [];
          return [
            [
              `Reference ${part.reference}`,
              part.content,
              ...(part.comment ? ["Your comment", part.comment] : []),
            ].join("\n"),
          ];
        })
        .join("\n\n")
        .trim() || message.content
    : "";
  const assistantCopyContent = !isUser
    ? message.parts
        // Artifact parts contribute their textual summary, never icons or bodies.
        .filter(
          (part) =>
            part.type === "text" || part.type === "async-question" || part.type === "artifact",
        )
        .map((part) => part.content)
        .join("\n\n")
        .trim() || message.content
    : "";
  // Fork actions sit on every completed transcript section, including a
  // content-empty trailing row that is the only host of that affordance —
  // hiding the row there would strand the exchange.
  const hasAssistantFooterContent =
    !isUser && (Boolean(messageActions) || Boolean(assistantCopyContent));
  const handleUserLongPress = useCallback(async () => {
    if (!userCopyContent) return;

    try {
      await writeText(userCopyContent);
      toast.success("copied");
    } catch (error) {
      console.error("[NativeMessage] Failed to copy user prompt:", error);
      toast.error("Failed to copy message text");
    }
  }, [userCopyContent]);
  const durationLabel = useMemo(() => {
    if (isUser || isError || isSystem || previousMessage?.role !== "user") {
      return null;
    }

    return formatResponseDuration(previousMessage.createdAt, message.createdAt);
  }, [isUser, isError, isSystem, previousMessage, message.createdAt]);

  // Render error messages with special styling
  if (isError) {
    return (
      <MessageErrorAlert
        content={message.content}
        timestampLabel={formatTime(message.createdAt)}
        action={
          openCodeAuthProvider ? (
            <OpenCodeAuthRecoveryAction
              providerId={openCodeAuthProvider}
              containerId={containerId}
            />
          ) : undefined
        }
      />
    );
  }

  if (isPeerMail) {
    return (
      <MailTile
        mail={message.peerMail ?? peerMailFromContent(message)}
        expansionKey={`peer-mail:${stableAgentExpansionScope}:${message.id}`}
        timestampLabel={formatTime(message.createdAt)}
      />
    );
  }

  // A command the user ran with `!`: the card is the whole row, with no
  // author or footer, since neither the agent nor the user "said" it.
  const userCommandPart =
    message.parts.length === 1 && message.parts[0]?.type === "user-command"
      ? message.parts[0]
      : null;
  if (userCommandPart) {
    return (
      <div className="px-2 @sm:px-4 py-2" data-user-command-row="true">
        <div className="max-w-3xl mx-auto min-w-0">
          <UserCommandCard command={userCommandPart.userCommand} />
        </div>
      </div>
    );
  }

  // An approval an Orkestrator permission rule answered: one quiet line.
  const permissionRulePart =
    message.parts.length === 1 && message.parts[0]?.type === "permission-rule"
      ? message.parts[0]
      : null;
  if (permissionRulePart) {
    return (
      <div className="px-2 @sm:px-4 py-1" data-permission-rule-row="true">
        <div className="max-w-3xl mx-auto min-w-0">
          <PermissionRuleNote
            application={permissionRulePart.application}
            ruleExists={permissionRulePart.ruleExists}
          />
        </div>
      </div>
    );
  }

  // Render system messages with distinct info styling
  if (isSystem) {
    return (
      <>
        <div className="px-2 @sm:px-4 py-2">
          <div className="max-w-3xl mx-auto min-w-0">
            <div
              data-agent-chat-search-content="true"
              // Most system messages are one-line markers, for which
              // `whitespace-pre-line` changes nothing. Multi-paragraph ones — the
              // build pipeline's auto-decline record — would otherwise collapse
              // into a single centred run of text.
              className="text-xs text-muted-foreground italic text-center py-1 break-words whitespace-pre-line"
            >
              {message.content}
            </div>
          </div>
        </div>
        {isClaudeAuthError ? (
          <ClaudeAuthRecoveryCard
            error={message.content}
            failureAt={message.createdAt}
            containerId={containerId}
          />
        ) : null}
      </>
    );
  }

  // An assistant row with no content, no actions and nothing to copy would
  // render as a bare `py-3` spacer: a gap the reader cannot account for. Drop
  // it entirely rather than reserve blank space for it.
  if (!isUser && !hasContent && !hasAssistantFooterContent) {
    return null;
  }

  return (
    <RichMessageContext.Provider value={richMessageIdentity}>
      <ToolDetailLoaderContext.Provider value={loadToolDetails}>
        <BackgroundTaskStopContext.Provider value={stopBackgroundTask}>
          <AsyncQuestionResponseContext.Provider
            value={{
              responses: asyncQuestionResponses,
              respond: respondToAsyncQuestion,
              draftScope: stableAgentExpansionScope,
            }}
          >
            <AgentPlatformContext.Provider value={platform}>
              <ModelLabelResolverContext.Provider value={resolveModelLabel}>
                <AgentExpansionScopeContext.Provider value={stableAgentExpansionScope}>
                  <MessageExpansionScopeContext.Provider value={messageAgentExpansionScope}>
                    <UserPromptEvidenceContext.Provider value={message.promptEvidence}>
                      <NativeMessagePartRendererContext.Provider
                        value={(props) => (
                          <MessagePart
                            {...props}
                            suppressImageReadPreview={
                              props.suppressImageReadPreview ??
                              (props.part.type === "tool-invocation" &&
                                Boolean(
                                  props.part.toolUseId &&
                                  toolIdsWithFirstClassImages.has(props.part.toolUseId),
                                ))
                            }
                          />
                        )}
                      >
                        <MessageShell
                          isUser={isUser}
                          authorLabel={isUser ? "You" : assistantAuthorLabel}
                          timestampLabel={formatTime(message.createdAt)}
                          durationLabel={durationLabel}
                          showHeader={!isContinuation}
                          showFooter={isUser || showAssistantFooter || hasAssistantFooterContent}
                          className={cn(!isUser && (isContinuation ? "pt-0 pb-3" : "py-3"))}
                          onUserLongPress={
                            isUser && userCopyContent ? handleUserLongPress : undefined
                          }
                          actions={
                            (isUser ? userCopyContent : assistantCopyContent) || messageActions ? (
                              <>
                                {messageActions}
                                {(isUser ? userCopyContent : assistantCopyContent) ? (
                                  <MessageCopyButton
                                    content={isUser ? userCopyContent : assistantCopyContent}
                                    wrapperClassName="mt-0 pr-0"
                                  />
                                ) : null}
                              </>
                            ) : undefined
                          }
                        >
                          {annotationMarker ? (
                            <WebAnnotationRequestChip
                              requestId={annotationMarker.requestId}
                              operation={annotationMarker.operation}
                              annotationCount={annotationMarker.annotationCount}
                            />
                          ) : null}
                          {isUser && message.promptEvidence ? (
                            <div className="pb-2">
                              <JsonPayloadPart
                                payload={structuredReviewJsonPayload(message.promptEvidence)}
                                expansionKey={`${message.id}-content/json/prompt-evidence`}
                              />
                            </div>
                          ) : null}
                          {renderMessageParts(message, {
                            showTextCopy: false,
                            containerId,
                            toolIdsWithFirstClassImages,
                            identityScope: stableAgentExpansionScope,
                          })}

                          {!hasTextParts && message.content && (
                            <TextPart
                              content={message.content}
                              showCopy={false}
                              truncateUserPrompt={isUser}
                              promptPresentation={message.promptPresentation}
                              renderJsonPayload={!isUser}
                              expansionKey={`${message.id}-content/json`}
                            />
                          )}
                        </MessageShell>
                      </NativeMessagePartRendererContext.Provider>
                    </UserPromptEvidenceContext.Provider>
                  </MessageExpansionScopeContext.Provider>
                </AgentExpansionScopeContext.Provider>
              </ModelLabelResolverContext.Provider>
            </AgentPlatformContext.Provider>
          </AsyncQuestionResponseContext.Provider>
        </BackgroundTaskStopContext.Provider>
      </ToolDetailLoaderContext.Provider>
    </RichMessageContext.Provider>
  );
});

/** A peer-mail row built without structured mail (a direct caller): read its frame back. */
function peerMailFromContent(message: NativeMessageType): PeerMailPresentation {
  const { heading, warning, body } = splitPeerMailNativeMessageContent(message.content);
  return {
    messageId: message.id.slice(PEER_MAIL_MESSAGE_PREFIX.length),
    kind: "message",
    sender: heading.replace(/^Message from /, ""),
    warning,
    body,
  };
}

function renderMessageParts(
  message: NativeMessageType,
  options: {
    showTextCopy?: boolean;
    containerId?: string;
    toolIdsWithFirstClassImages?: ReadonlySet<string>;
    /** The transcript scope source identities are unique within. */
    identityScope?: string;
  } = {},
) {
  const promptPresentationPartIndex = message.promptPresentation
    ? message.parts.findIndex((part) => part.type === "text")
    : -1;
  const identities = partIdentities(message, options.identityScope);
  const renderPart = (part: NativeMessagePart, index: number) => (
    <MessagePart
      key={identities[index]!.key}
      part={part}
      showTextCopy={options.showTextCopy ?? true}
      truncateUserPrompt={message.role === "user"}
      promptPresentation={
        index === promptPresentationPartIndex ? message.promptPresentation : undefined
      }
      renderJsonPayload={message.role !== "user"}
      containerId={options.containerId}
      eagerImagePreview={message.role === "user"}
      suppressImageReadPreview={
        part.type === "tool-invocation" &&
        Boolean(part.toolUseId && options.toolIdsWithFirstClassImages?.has(part.toolUseId))
      }
      partKey={identities[index]!.partKey}
    />
  );

  const renderedParts: ReactNode[] = [];
  let index = 0;

  while (index < message.parts.length) {
    const part = message.parts[index];
    if (part?.type !== "file") {
      if (part) renderedParts.push(renderPart(part, index));
      index += 1;
      continue;
    }

    const flowStart = index;
    const flowParts: ReactNode[] = [];
    while (index < message.parts.length && message.parts[index]?.type === "file") {
      const flowPart = message.parts[index];
      if (flowPart) flowParts.push(renderPart(flowPart, index));
      index += 1;
    }

    renderedParts.push(
      <div
        key={`${message.id}-attachment-flow-${flowStart}`}
        data-message-attachment-flow="true"
        className="flex w-full min-w-0 flex-wrap items-start gap-3"
      >
        {flowParts}
      </div>,
    );
  }

  return renderedParts;
}

/**
 * A part's identity within its conversation: its source occurrence (source
 * message plus the provider's part or call id) when it has one. Never a
 * content hash — a streaming token must not change it — and never its
 * position, which history paging and coalescing shift.
 */
export function sourcePartIdentity(part: NativeMessagePart): string | undefined {
  const id =
    part.type === "tool-invocation" ? (part.toolUseId ?? part.sourcePartId) : part.sourcePartId;
  if (!id) return undefined;
  return part.sourceMessageId ? `${part.sourceMessageId}:${id}` : id;
}

/**
 * React keys and `partKey`s for a message's parts. A part with a source
 * identity keeps both across appends, merges into a coalesced row and renames
 * of that row; a legacy part without one falls back to its position. Two
 * parts claiming one identity (a provider reusing an id) are told apart by
 * position rather than colliding.
 */
function partIdentities(
  message: NativeMessageType,
  scope: string | undefined,
): Array<{ key: string; partKey: string }> {
  const used = new Set<string>();
  return message.parts.map((part, index) => {
    const identity = sourcePartIdentity(part);
    let key = identity ? `src:${identity}` : `${message.id}-part-${index}-${part.type}`;
    if (used.has(key)) key = `${key}#${index}`;
    used.add(key);
    const partKey =
      identity && !key.includes("#")
        ? `src:${JSON.stringify([scope ?? message.id, identity])}`
        : `${message.id}-part-${index}`;
    return { key, partKey };
  });
}

function firstClassImageToolUseIds(parts: readonly NativeMessagePart[]): ReadonlySet<string> {
  const result = new Set<string>();
  for (const part of parts) {
    if (part.type !== "image" || part.imageSource !== "viewed") continue;
    const toolUseId = toolUseIdFromImagePartId(part.sourcePartId);
    if (toolUseId) result.add(toolUseId);
  }
  return result;
}

function formatTime(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function formatResponseDuration(startIso: string, endIso: string): string | null {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }

  const seconds = Math.max(1, Math.round((end - start) / 1000));
  return `responded in ${formatElapsed(seconds)}`;
}

function isSameMinute(a: string, b: string): boolean {
  try {
    const first = new Date(a);
    const second = new Date(b);

    if (Number.isNaN(first.getTime()) || Number.isNaN(second.getTime())) {
      return false;
    }

    return (
      first.getFullYear() === second.getFullYear() &&
      first.getMonth() === second.getMonth() &&
      first.getDate() === second.getDate() &&
      first.getHours() === second.getHours() &&
      first.getMinutes() === second.getMinutes()
    );
  } catch {
    return false;
  }
}
