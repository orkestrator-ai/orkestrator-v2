import { useContext, useEffect, useState } from "react";
import { isEditTool } from "@/lib/tool-names";
import { isTodoTool } from "@/lib/todo-tool";
import { TodoToolPart } from "@/components/todo/TodoToolPart";
import { type NativeMessagePart } from "@/lib/chat/native-message-types";
import type { NativeAgentToolDetails } from "@orkestrator/protocol/native-agent";
import { useMessagePartExpansion } from "@/lib/chat/message-part-expansion";
import {
  MessageExpansionScopeContext,
  ToolDetailLoaderContext,
  cachedToolDetails,
  cacheToolDetails,
  getToolExpansionKey,
} from "./NativeMessage.shared";
import {
  EditToolPart,
  ThinkingPart,
  ToolPart,
  hasRenderableDiff,
} from "./NativeMessage.basic-parts";
import { FilePart, TextPart } from "./NativeMessage.file-parts";
import {
  AgentGroupPart,
  SubagentPart,
  TaskGroupPart,
  ToolGroupPart,
} from "./NativeMessage.agent-parts";

export function DeferredToolMessagePart({
  part,
  partKey,
  showTextCopy,
  truncateUserPrompt,
  renderJsonPayload,
  containerId,
  eagerImagePreview,
}: {
  part: Extract<NativeMessagePart, { type: "tool-invocation" }>;
  partKey: string;
  showTextCopy: boolean;
  truncateUserPrompt: boolean;
  renderJsonPayload: boolean;
  containerId?: string;
  eagerImagePreview: boolean;
}) {
  const loadToolDetails = useContext(ToolDetailLoaderContext);
  const expansionScope = useContext(MessageExpansionScopeContext);
  const expansionKey = `native-tool:${expansionScope}:${getToolExpansionKey(part, partKey)}`;
  const [isOpen] = useMessagePartExpansion(expansionKey);
  const detailRef = part.detailRef!;
  const [details, setDetails] = useState<NativeAgentToolDetails | undefined>(() =>
    cachedToolDetails(detailRef),
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const cached = cachedToolDetails(detailRef);
    if (cached) {
      setDetails(cached);
      setLoadError(null);
      return;
    }
    setDetails(undefined);
    setLoadError(null);
  }, [detailRef]);

  useEffect(() => {
    if (!isOpen || details || loadError || !loadToolDetails) return;
    let cancelled = false;
    void loadToolDetails(detailRef)
      .then((loaded) => {
        if (cancelled) return;
        cacheToolDetails(loaded);
        setDetails(loaded);
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : "Tool details are unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [detailRef, details, isOpen, loadError, loadToolDetails]);

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
    ...(details?.toolOutput !== undefined ? { toolOutput: details.toolOutput } : {}),
    ...(details?.toolError !== undefined ? { toolError: details.toolError } : {}),
    ...(!details && loadError ? { toolError: loadError } : {}),
    ...(!details && !loadError && isOpen ? { toolOutput: "Loading tool details…" } : {}),
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
      deferredDetails={!details}
      partKey={partKey}
      showTextCopy={showTextCopy}
      truncateUserPrompt={truncateUserPrompt}
      renderJsonPayload={renderJsonPayload}
      containerId={containerId}
      eagerImagePreview={eagerImagePreview}
    />
  );
}

/** Render a single message part based on its type */
export function MessagePart({
  part,
  showTextCopy = true,
  truncateUserPrompt = false,
  renderJsonPayload = true,
  containerId,
  eagerImagePreview = false,
  partKey,
  deferredDetails = false,
  embedded = false,
}: {
  part: NativeMessagePart;
  showTextCopy?: boolean;
  truncateUserPrompt?: boolean;
  renderJsonPayload?: boolean;
  containerId?: string;
  eagerImagePreview?: boolean;
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
  if (part.type === "tool-invocation" && part.detailRef && loadToolDetails) {
    return (
      <DeferredToolMessagePart
        part={part}
        partKey={partKey}
        showTextCopy={showTextCopy}
        truncateUserPrompt={truncateUserPrompt}
        renderJsonPayload={renderJsonPayload}
        containerId={containerId}
        eagerImagePreview={eagerImagePreview}
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
      return <ThinkingPart content={part.content} expansionKey={partKey} />;
    case "text":
      return (
        <TextPart
          content={part.content}
          showCopy={showTextCopy}
          truncateUserPrompt={truncateUserPrompt}
          renderJsonPayload={renderJsonPayload}
          expansionKey={`${partKey}/json`}
        />
      );
    case "tool-invocation":
      // ACP identifies file mutations through diff content as well as tool kind.
      // Render any part carrying an actual diff with the edit treatment, while a
      // location-only hint on read/search tools remains a generic tool row.
      if (isEditTool(part.toolName) || hasRenderableDiff(part.toolDiff)) {
        return (
          <EditToolPart
            expansionKey={toolExpansionKey}
            toolName={part.toolName}
            toolState={part.toolState}
            toolTitle={part.toolTitle}
            toolOutput={part.toolOutput}
            toolError={part.toolError}
            toolDiff={part.toolDiff}
            deferredDetails={deferredDetails}
          />
        );
      }
      // Use specialized TodoToolPart for TodoWrite / Cursor updateTodos / Grok todo_write tools
      if (isTodoTool(part.toolName)) {
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
      // Use generic ToolPart for other tools
      return (
        <ToolPart
          expansionKey={toolExpansionKey}
          toolName={part.toolName}
          toolState={part.toolState}
          toolTitle={part.toolTitle}
          toolArgs={part.toolArgs}
          toolOutput={part.toolOutput}
          toolError={part.toolError}
          backgroundTask={part.backgroundTask}
          deferredDetails={deferredDetails}
        />
      );
    case "tool-result":
      // Tool results are typically shown inline with tool invocations
      return null;
    case "file":
      return (
        <FilePart
          path={part.content}
          fileUrl={part.fileUrl}
          filename={part.filename}
          containerId={containerId}
          eagerPreview={eagerImagePreview}
        />
      );
    case "subagent":
      return (
        <SubagentPart part={part} containerId={containerId} partKey={partKey} embedded={embedded} />
      );
    case "agent-group":
      return <AgentGroupPart part={part} containerId={containerId} partKey={partKey} />;
    case "tool-group":
      return <ToolGroupPart part={part} containerId={containerId} partKey={partKey} />;
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
