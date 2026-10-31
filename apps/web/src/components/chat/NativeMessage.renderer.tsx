import { PermissionRuleNote } from "./PermissionRuleNote";
import { useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { RichMessageContext, useRichMessageIdentity } from "@/lib/chat/rich-identity";
import { imageReadFromToolPart, type ImageRead } from "@/lib/chat/image-read";
import { isPlanTool } from "@/lib/plan-tool";
import { isTodoTool } from "@/lib/todo-tool";
import { agentMailToolCall } from "@/lib/chat/agent-mail-tool-call";
import { MailToolPart } from "./MailToolPart";
import { TodoToolPart } from "@/components/todo/TodoToolPart";
import { PlanToolPart } from "./PlanToolPart";
import { type NativeMessagePart } from "@/lib/chat/native-message-types";
import { useMessagePartExpansion } from "@/lib/chat/message-part-expansion";
import {
  MessageExpansionScopeContext,
  ToolDetailLoaderContext,
  getToolExpansionKey,
  useToolDetails,
} from "./NativeMessage.shared";
import {
  EditToolPart,
  ThinkingPart,
  ToolPart,
  hasRenderableDiff,
} from "./NativeMessage.basic-parts";
import { isFileToolKind, useToolChangeKind } from "./NativeMessage.change-parts";
import {
  FilePart,
  TextPart,
  TranscriptReferencePart,
  canLoadImagePreview,
} from "./NativeMessage.file-parts";
import { CompactionPart, ImagePart, RetryPart, StatusPart } from "./NativeMessage.notice-parts";
import { AgentGroupPart, SubagentPart, TaskGroupPart } from "./NativeMessage.agent-parts";
import { NativeAsyncQuestionCard } from "./NativeAsyncQuestionCard";
import { ArtifactPart } from "./rich/ArtifactPart";
import { UserCommandCard } from "./UserCommandCard";
import { ToolGroupPart } from "./NativeMessage.tool-group";

export function DeferredToolMessagePart({
  part,
  partKey,
  showTextCopy,
  truncateUserPrompt,
  renderJsonPayload,
  containerId,
  eagerImagePreview,
  suppressImageReadPreview,
}: {
  part: Extract<NativeMessagePart, { type: "tool-invocation" }>;
  partKey: string;
  showTextCopy: boolean;
  truncateUserPrompt: boolean;
  renderJsonPayload: boolean;
  containerId?: string;
  eagerImagePreview: boolean;
  suppressImageReadPreview?: boolean;
}) {
  const expansionScope = useContext(MessageExpansionScopeContext);
  const expansionKey = `native-tool:${expansionScope}:${getToolExpansionKey(part, partKey)}`;
  const [isOpen] = useMessagePartExpansion(expansionKey);
  // A mail call is drawn as its message, and a read's message is in the result.
  const eagerDetails = isPlanTool(part.toolName) || agentMailToolCall(part) !== null;
  const wanted = isOpen || eagerDetails;
  const { details, error: loadError } = useToolDetails(part.detailRef, wanted);
  // The whole input, when the projection sent large values as previews.
  const { details: argsDetails } = useToolDetails(part.toolArgsDetailRef, wanted);
  const outputPending = part.detailRef !== undefined && !details;

  /*
   * The collapsed row shows the part's own metadata and nothing else. Earlier
   * revisions parked prose in `toolOutput` to keep the expand trigger enabled,
   * which put "Details load when expanded." where a diff summary belongs; the
   * `deferredDetails` prop carries that signal instead, leaving the body empty
   * until there is something real to put in it.
   */
  const materialized: Extract<NativeMessagePart, { type: "tool-invocation" }> = {
    ...part,
    detailRef: undefined,
    toolArgsDetailRef: undefined,
    // Until the input arrives the preview stands in; a failed read keeps it.
    ...(argsDetails?.toolArgs ? { toolArgs: argsDetails.toolArgs } : {}),
    ...(details?.toolOutput !== undefined ? { toolOutput: details.toolOutput } : {}),
    ...(details?.toolError !== undefined ? { toolError: details.toolError } : {}),
    ...(outputPending && loadError ? { toolError: loadError } : {}),
    ...(outputPending && !loadError && isOpen ? { toolOutput: "Loading tool details…" } : {}),
    ...(part.toolDiff || details?.toolDiff
      ? {
          toolDiff: {
            ...part.toolDiff,
            ...details?.toolDiff,
            // Cleared once the body is in hand: `deferred` exists to say the
            // real diff is still elsewhere.
            ...(details ? { deferred: undefined } : {}),
          },
        }
      : {}),
  };
  return (
    <MessagePart
      part={materialized}
      deferredDetails={outputPending}
      partKey={partKey}
      showTextCopy={showTextCopy}
      truncateUserPrompt={truncateUserPrompt}
      renderJsonPayload={renderJsonPayload}
      containerId={containerId}
      eagerImagePreview={eagerImagePreview}
      suppressImageReadPreview={suppressImageReadPreview}
    />
  );
}

/**
 * A recovered image preview that removes itself when the bytes cannot be read.
 *
 * `canLoadImagePreview` rejects what is knowably unreadable before anything
 * mounts, but on the host it cannot be exact: the renderer does not know the
 * worktree root the backend confines reads to, and it cannot know that a path
 * component is a symbolic link or that the file has since been deleted. This
 * preview was synthesized from a path argument rather than reported by the
 * transcript, so the honest answer to a failed load is to show nothing and
 * leave the tool row to speak for the call.
 */
function ImageReadPreview({
  imageRead,
  containerId,
  children,
}: {
  imageRead: ImageRead;
  containerId?: string;
  children: ReactNode;
}) {
  const [unavailable, setUnavailable] = useState(false);
  const handleUnavailable = useCallback(() => setUnavailable(true), []);

  if (unavailable) return <>{children}</>;
  return (
    <div className="space-y-1">
      {children}
      <ImagePart
        part={{
          type: "image",
          content: imageRead.path,
          fileUrl: imageRead.fileUrl,
          detailRef: imageRead.detailRef,
          filename: imageRead.filename,
          imageSource: "viewed",
        }}
        containerId={containerId}
        onUnavailable={handleUnavailable}
      />
    </div>
  );
}

/** Render a single message part based on its type */
export function MessagePart(props: Parameters<typeof MessagePartContent>[0]) {
  const part = props.part;
  // Rich block view state belongs to the part's source message, not to the
  // display row: coalescing renames the row that holds a part, which must not
  // reset a diagram's source view or a table's sort.
  const displayMessage = useRichMessageIdentity();
  const sourceMessageId = part.sourceMessageId;
  const richIdentity = useMemo(
    () =>
      sourceMessageId && displayMessage
        ? {
            messageId: sourceMessageId,
            role: displayMessage.role,
            ...(displayMessage.createdAt ? { createdAt: displayMessage.createdAt } : {}),
          }
        : null,
    [displayMessage, sourceMessageId],
  );
  // Source parts are the transcript's scroll anchors: a held or restored
  // place finds its part again by this id, whatever row now contains it.
  // Prose anchors at block level; file chips flow inline and stay unwrapped.
  const id =
    part.type === "tool-invocation"
      ? (part.toolUseId ?? part.sourcePartId)
      : part.type === "text"
        ? part.sourcePartId
        : undefined;
  const inner = <MessagePartContent {...props} />;
  const content = richIdentity ? (
    <RichMessageContext.Provider value={richIdentity}>{inner}</RichMessageContext.Provider>
  ) : (
    inner
  );
  return id ? <div data-transcript-part-id={id}>{content}</div> : content;
}

function MessagePartContent({
  part,
  showTextCopy = true,
  truncateUserPrompt = false,
  promptPresentation,
  renderJsonPayload = true,
  containerId,
  eagerImagePreview = false,
  partKey,
  deferredDetails = false,
  embedded = false,
  suppressImageReadPreview = false,
}: {
  part: NativeMessagePart;
  showTextCopy?: boolean;
  truncateUserPrompt?: boolean;
  promptPresentation?: import("@/lib/chat/native-message-types").NativeMessage["promptPresentation"];
  renderJsonPayload?: boolean;
  containerId?: string;
  eagerImagePreview?: boolean;
  /** A bridge already supplied the image bytes for this tool call. */
  suppressImageReadPreview?: boolean;
  /** Stable identity for this part's position, used to persist expansion state. */
  partKey: string;
  /**
   * Set by `DeferredToolMessagePart` while a tool row's heavy fields are still
   * behind their `detailRef`. Tool rows gate their expand trigger on having
   * something to show, and a deferred row has nothing until it is expanded.
   */
  deferredDetails?: boolean;
  /** Drop individual card chrome when this row already sits in a shared group. */
  embedded?: boolean;
}) {
  const loadToolDetails = useContext(ToolDetailLoaderContext);
  const expansionScope = useContext(MessageExpansionScopeContext);
  // The backend's tool kind for this call, once its presentation is known.
  const changeToolKind = useToolChangeKind(
    part.type === "tool-invocation" ? part.toolUseId : undefined,
    part.sourceMessageId,
  );
  if (
    part.type === "tool-invocation" &&
    (part.detailRef || part.toolArgsDetailRef) &&
    loadToolDetails
  ) {
    return (
      <DeferredToolMessagePart
        part={part}
        partKey={partKey}
        showTextCopy={showTextCopy}
        truncateUserPrompt={truncateUserPrompt}
        renderJsonPayload={renderJsonPayload}
        containerId={containerId}
        eagerImagePreview={eagerImagePreview}
        suppressImageReadPreview={suppressImageReadPreview}
      />
    );
  }
  const toolExpansionKey =
    part.type === "tool-invocation"
      ? `native-tool:${expansionScope}:${getToolExpansionKey(part, partKey)}`
      : "";

  switch (part.type) {
    case "thinking":
      // Thinking parts are typically rendered directly in NativeMessage with isComplete
      // If rendered through MessagePart, assume complete (collapsed by default)
      return (
        <ThinkingPart
          content={part.content}
          contentDetailRef={part.contentDetailRef}
          expansionKey={partKey}
        />
      );
    case "text":
      return (
        <TextPart
          content={part.content}
          showCopy={showTextCopy}
          truncateUserPrompt={truncateUserPrompt}
          promptPresentation={promptPresentation}
          renderJsonPayload={renderJsonPayload}
          expansionKey={`${partKey}/json`}
          richPartId={part.sourcePartId ?? partKey}
          containerId={containerId}
        />
      );
    case "transcript-reference":
      return <TranscriptReferencePart part={part} />;
    case "async-question":
      return <NativeAsyncQuestionCard part={part} />;
    case "tool-invocation": {
      const mailCall = part.toolDenied ? null : agentMailToolCall(part);
      if (mailCall) return <MailToolPart call={mailCall} expansionKey={toolExpansionKey} />;
      // File tools render as an edit card when the backend's presentation says
      // so, or — before or without a presentation — when the part structurally
      // carries a diff payload. Provider tool names are never classified here;
      // a location-only hint on a read/search tool stays a generic tool row.
      if (
        !part.toolDenied &&
        (isFileToolKind(changeToolKind) || hasRenderableDiff(part.toolDiff))
      ) {
        return (
          <EditToolPart
            expansionKey={toolExpansionKey}
            callId={part.toolUseId}
            occurrenceId={part.sourceMessageId}
            toolName={part.toolName}
            toolState={part.toolState}
            toolTitle={part.toolTitle}
            toolOutput={part.toolOutput}
            toolError={part.toolError}
            toolDiff={part.toolDiff}
            durationMs={part.toolDurationMs}
            deferredDetails={deferredDetails}
          />
        );
      }
      if (!part.toolDenied && isPlanTool(part.toolName)) {
        return (
          <PlanToolPart
            toolName={part.toolName}
            toolState={part.toolState}
            toolTitle={part.toolTitle}
            toolArgs={part.toolArgs}
            toolOutput={part.toolOutput}
            toolError={part.toolError}
            deferredDetails={deferredDetails}
          />
        );
      }
      // Use specialized TodoToolPart for TodoWrite / Cursor updateTodos / Grok todo_write tools
      if (!part.toolDenied && isTodoTool(part.toolName)) {
        return (
          <TodoToolPart
            expansionKey={toolExpansionKey}
            toolName={part.toolName}
            toolState={part.toolState}
            toolArgs={part.toolArgs}
            toolOutput={part.toolOutput}
            toolError={part.toolError}
            taskSnapshot={part.taskSnapshot}
            deferredDetails={deferredDetails}
          />
        );
      }
      // Codex already emits a first-class `image` part for viewed files. Every
      // other platform reports the same action as a Read with a path, so the
      // preview is recovered here — one place, every transcript.
      const imageRead = suppressImageReadPreview ? null : imageReadFromToolPart(part);
      const toolCard = (
        <ToolPart
          expansionKey={toolExpansionKey}
          callId={part.toolUseId}
          occurrenceId={part.sourceMessageId}
          toolName={part.toolName}
          toolState={part.toolState}
          toolTitle={part.toolTitle}
          mcpServerName={part.mcpServerName}
          toolArgs={part.toolArgs}
          toolOutput={part.toolOutput}
          toolError={part.toolError}
          backgroundTask={part.backgroundTask}
          progress={part.progress}
          denied={part.toolDenied}
          commandChanges={part.commandChanges}
          durationMs={part.toolDurationMs}
          deferredDetails={deferredDetails}
        />
      );
      if (!imageRead || !canLoadImagePreview(imageRead.path, imageRead.fileUrl, containerId)) {
        return toolCard;
      }
      return (
        <ImageReadPreview imageRead={imageRead} containerId={containerId} key={imageRead.path}>
          {toolCard}
        </ImageReadPreview>
      );
    }
    case "tool-result":
      // Tool results are typically shown inline with tool invocations
      return null;
    case "file":
      return (
        <FilePart
          path={part.content}
          fileUrl={part.fileUrl}
          detailRef={part.detailRef}
          filename={part.filename}
          containerId={containerId}
          eagerPreview={eagerImagePreview}
          hideThumbnailCaption={eagerImagePreview}
        />
      );
    case "compaction":
      return <CompactionPart part={part} expansionKey={`${partKey}/compaction`} />;
    case "retry":
      return <RetryPart part={part} />;
    case "status":
      return <StatusPart part={part} />;
    case "image":
      return <ImagePart part={part} containerId={containerId} />;
    case "subagent":
      return (
        <SubagentPart part={part} containerId={containerId} partKey={partKey} embedded={embedded} />
      );
    case "agent-group":
      return <AgentGroupPart part={part} containerId={containerId} partKey={partKey} />;
    case "tool-group":
      return <ToolGroupPart part={part} containerId={containerId} partKey={partKey} />;
    case "artifact":
      // A published artifact reference; the card resolves it through the
      // authenticated conversation scope and never trusts its own text.
      return <ArtifactPart part={part} />;
    case "user-command":
      return <UserCommandCard command={part.userCommand} />;
    case "permission-rule":
      return <PermissionRuleNote application={part.application} ruleExists={part.ruleExists} />;
    case "task-group":
      return (
        <TaskGroupPart
          part={part}
          containerId={containerId}
          partKey={partKey}
          embedded={embedded}
        />
      );
    default:
      return null;
  }
}
