import {
  memo,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { writeText } from "@/lib/native/clipboard";
import {
  ERROR_MESSAGE_PREFIX,
  SYSTEM_MESSAGE_PREFIX,
} from "@/lib/opencode-client";
import { MessageErrorAlert, MessageShell } from "@/components/chat/MessageShell";
import { MessageCopyButton } from "@/components/chat/MessageCopyButton";
import { formatElapsed } from "@/lib/format-elapsed";
import {
  type NativeMessage as NativeMessageType,
  type NativeMessagePart,
} from "@/lib/chat/native-message-types";
import {
  messageHasVisibleContent,
  normalizeNativeMessage,
} from "@/lib/chat/native-message-adapters";
import {
  AgentPlatformContext,
  BackgroundTaskStopContext,
  MessageExpansionScopeContext,
  NativeMessagePartRendererContext,
  ToolDetailLoaderContext,
  type NativeMessageProps,
} from "./NativeMessage.shared";
import { MessagePart } from "./NativeMessage.renderer";
import { TextPart } from "./NativeMessage.file-parts";

export const NativeMessage = memo(function NativeMessage({
  message,
  previousMessage = null,
  assistantLabel = "Assistant",
  containerId,
  agentExpansionScope,
  actions: messageActions,
  resolveModelLabel,
  loadToolDetails,
  stopBackgroundTask,
  platform,
}: NativeMessageProps) {
  const normalizedMessage = useMemo(() => normalizeNativeMessage(message), [message]);
  const normalizedPreviousMessage = useMemo(
    () => previousMessage ? normalizeNativeMessage(previousMessage) : null,
    [previousMessage],
  );
  message = normalizedMessage;
  previousMessage = normalizedPreviousMessage;

  // A container id can legitimately appear after this row mounts (notably in
  // build-pipeline tabs) or change when a container is recreated. Freeze the
  // namespace at mount so such lifecycle updates do not silently collapse an
  // open disclosure. Production transcript owners pass their stable
  // environment/session identity; the initial container remains a safe fallback
  // for direct callers.
  const [stableAgentExpansionScope] = useState(
    () => agentExpansionScope ?? containerId ?? "host",
  );
  const messageAgentExpansionScope = JSON.stringify([
    stableAgentExpansionScope,
    message.id,
  ]);

  const isUser = message.role === "user";
  const isError = message.id.startsWith(ERROR_MESSAGE_PREFIX);
  const isSystem = message.role === "system" || message.id.startsWith(SYSTEM_MESSAGE_PREFIX);
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

  const hasTextParts = message.parts.some((part) => part.type === "text");
  const hasContent = messageHasVisibleContent(message);
  // Transcript owners resolve `previousMessage` to the nearest content-bearing
  // predecessor (see findPreviousNativeMessage), so a `user → empty → content`
  // block still anchors duration on the user and a `content → empty → content`
  // block does not repeat attribution. The `previousHasContent` guard below
  // remains a safety net for direct callers passing the raw predecessor.
  const previousHasContent = previousMessage
    ? messageHasVisibleContent(previousMessage)
    : false;
  // Attribution belongs on the first content-bearing message of a transcript
  // block. Empty assistant messages (an info-only `message.updated` before any
  // part streams) carry no attribution, and same-block continuations drop the
  // model label so it is not repeated for every streamed chunk.
  const showAssistantFooter =
    !isUser && !isSystem && !isError && hasContent;
  // A continuation that switched model is the one case where repeating the
  // label carries information: providers stamp `modelId` per message (Claude
  // records one per tool round-trip), so a mid-block fallback would otherwise
  // leave the new model rendering under the previous row's label.
  const showAssistantAuthorLabel =
    showAssistantFooter
    && (
      !isContinuation
      || !previousHasContent
      || previousMessage?.modelId !== message.modelId
    );
  const userCopyContent = isUser
    ? (
        message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.content)
          .join("\n\n")
          .trim() || message.content
      )
    : "";
  const assistantCopyContent = !isUser
    ? (
        message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.content)
          .join("\n\n")
          .trim() || message.content
      )
    : "";
  // Whether the assistant footer still has a reason to exist once attribution
  // is suppressed. Fork actions sit on every completed transcript section,
  // including a content-empty trailing row that is the only host of that
  // affordance — hiding the row there would strand the exchange.
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
      />
    );
  }

  // Render system messages with distinct info styling
  if (isSystem) {
    return (
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
    );
  }

  // An assistant row with no content, no actions and nothing to copy would
  // render as a bare `py-3` spacer: a gap the reader cannot account for. Drop
  // it entirely rather than reserve blank space for it.
  if (!isUser && !hasContent && !hasAssistantFooterContent) {
    return null;
  }

  return (
    <ToolDetailLoaderContext.Provider value={loadToolDetails}>
      <BackgroundTaskStopContext.Provider value={stopBackgroundTask}>
      <AgentPlatformContext.Provider value={platform}>
        <MessageExpansionScopeContext.Provider value={messageAgentExpansionScope}>
        <NativeMessagePartRendererContext.Provider value={(props) => <MessagePart {...props} />}>
        <MessageShell
        isUser={isUser}
        authorLabel={
          isUser
            ? "You"
            : assistantAuthorLabel
        }
        timestampLabel={formatTime(message.createdAt)}
        durationLabel={durationLabel}
        showHeader={!isContinuation}
        showFooter={isUser || showAssistantFooter || hasAssistantFooterContent}
        showAuthorLabel={isUser || showAssistantAuthorLabel}
        className={cn(!isUser && (isContinuation ? "pt-0 pb-3" : "py-3"))}
        onUserLongPress={isUser && userCopyContent ? handleUserLongPress : undefined}
        actions={(isUser ? userCopyContent : assistantCopyContent) || messageActions ? (
          <>
            {messageActions}
            {(isUser ? userCopyContent : assistantCopyContent) ? (
              <MessageCopyButton
                content={isUser ? userCopyContent : assistantCopyContent}
                wrapperClassName="mt-0 pr-0"
              />
            ) : null}
          </>
        ) : undefined}
      >
        {renderMessageParts(message, { showTextCopy: false, containerId })}

        {!hasTextParts && message.content && (
          <TextPart
            content={message.content}
            showCopy={false}
            truncateUserPrompt={isUser}
            renderJsonPayload={!isUser}
            expansionKey={`${message.id}-content/json`}
          />
        )}
        </MessageShell>
        </NativeMessagePartRendererContext.Provider>
        </MessageExpansionScopeContext.Provider>
      </AgentPlatformContext.Provider>
      </BackgroundTaskStopContext.Provider>
    </ToolDetailLoaderContext.Provider>
  );
});

function renderMessageParts(
  message: NativeMessageType,
  options: { showTextCopy?: boolean; containerId?: string } = {},
) {
  const renderPart = (part: NativeMessagePart, index: number) => (
    <MessagePart
      key={`${message.id}-part-${index}-${part.type}`}
      part={part}
      showTextCopy={options.showTextCopy ?? true}
      truncateUserPrompt={message.role === "user"}
      renderJsonPayload={message.role !== "user"}
      containerId={options.containerId}
      eagerImagePreview={message.role === "user"}
      partKey={`${message.id}-part-${index}`}
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
