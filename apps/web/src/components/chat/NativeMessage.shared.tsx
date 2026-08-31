import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { MarkdownLink } from "@/components/chat/MessageMarkdown";
import { type Components } from "react-markdown";
import {
  type NativeAgentActivityPart,
  type NativeMessage as NativeMessageType,
  type NativeMessagePart,
} from "@/lib/chat/native-message-types";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { NativeAgentToolDetails } from "@orkestrator/protocol/native-agent";
import { useMessagePartExpansion } from "@/lib/chat/message-part-expansion";

/** Markdown components config shared by every native transcript part. */
export const markdownComponents: Components = {
  a: MarkdownLink,
};

export const TASK_LIST_SYNTAX_PATTERN = /(^|\n)\s*(?:[-*+]|\d+\.)\s+\[(?: |x|X)\]\s+/m;
export const USER_PROMPT_COLLAPSED_LINE_COUNT = 12;

export interface NativeMessageProps {
  message: NativeMessageType;
  previousMessage?: NativeMessageType | null;
  assistantLabel?: string;
  containerId?: string;
  /** Stable transcript/environment identity used to isolate persisted disclosures. */
  agentExpansionScope?: string;
  /**
   * Provider that produced this transcript. Cursor does not report nested
   * sub-agent tool activity, so its agent rows hide tool/update counts and
   * surface launch metadata instead.
   */
  platform?: AgentPlatform;
  actions?: ReactNode;
  resolveModelLabel?: (modelId: string) => string;
  loadToolDetails?: (detailRef: string) => Promise<NativeAgentToolDetails>;
  /**
   * Stops a provider-owned background task. Must be referentially stable, or
   * `memo(NativeMessage)` stops holding for the whole transcript.
   */
  stopBackgroundTask?: (taskId: string) => Promise<boolean>;
}

export const MessageExpansionScopeContext = createContext("native-message");
export const AgentPlatformContext = createContext<AgentPlatform | undefined>(undefined);
/**
 * Stops a provider-owned background task, resolving `true` once the backend
 * accepted the request.
 *
 * Supplied through context rather than threaded down as a prop because the card
 * that offers the control is an ordinary transcript part, nested arbitrarily
 * deep inside grouped activity. Absent means the tab cannot stop tasks, and the
 * card must then not offer a control it cannot honour.
 */
export const BackgroundTaskStopContext = createContext<
  ((taskId: string) => Promise<boolean>) | undefined
>(undefined);
export const ToolDetailLoaderContext = createContext<
  ((detailRef: string) => Promise<NativeAgentToolDetails>) | undefined
>(undefined);
const TOOL_DETAIL_BROWSER_CACHE_MAX_ENTRIES = 256;
const TOOL_DETAIL_BROWSER_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const toolDetailBrowserCache = new Map<
  string,
  {
    details: NativeAgentToolDetails;
    bytes: number;
  }
>();
let toolDetailBrowserCacheBytes = 0;

export function cachedToolDetails(detailRef: string): NativeAgentToolDetails | undefined {
  const entry = toolDetailBrowserCache.get(detailRef);
  if (!entry) return undefined;
  toolDetailBrowserCache.delete(detailRef);
  toolDetailBrowserCache.set(detailRef, entry);
  return entry.details;
}

export function cacheToolDetails(details: NativeAgentToolDetails): void {
  const bytes = new TextEncoder().encode(JSON.stringify(details)).byteLength;
  const previous = toolDetailBrowserCache.get(details.detailRef);
  if (previous) toolDetailBrowserCacheBytes -= previous.bytes;
  toolDetailBrowserCache.delete(details.detailRef);
  toolDetailBrowserCache.set(details.detailRef, { details, bytes });
  toolDetailBrowserCacheBytes += bytes;
  while (
    toolDetailBrowserCache.size > TOOL_DETAIL_BROWSER_CACHE_MAX_ENTRIES ||
    toolDetailBrowserCacheBytes > TOOL_DETAIL_BROWSER_CACHE_MAX_BYTES
  ) {
    const oldest = toolDetailBrowserCache.keys().next().value;
    if (!oldest) break;
    const entry = toolDetailBrowserCache.get(oldest);
    if (entry) toolDetailBrowserCacheBytes -= entry.bytes;
    toolDetailBrowserCache.delete(oldest);
  }
}

/**
 * A tool row's own result, fetched on first expansion when the projection has
 * moved it behind a detail reference.
 *
 * Agent and background-task cards render a launch result inside their own
 * layout rather than as a whole tool row, so they cannot reuse
 * `DeferredToolMessagePart`. Without this they show an empty body for every
 * projected row: `projectionPart` strips `toolOutput` from *every* part it
 * sends, so the inline field survives only on optimistic and bridge-direct
 * messages.
 */
export function useDeferredToolResult(
  source: { toolOutput?: string; toolError?: string; detailRef?: string },
  open: boolean,
): { toolOutput?: string; toolError?: string } {
  const loadToolDetails = useContext(ToolDetailLoaderContext);
  const detailRef = source.detailRef;
  const [details, setDetails] = useState<NativeAgentToolDetails | undefined>(() =>
    detailRef ? cachedToolDetails(detailRef) : undefined,
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setDetails(detailRef ? cachedToolDetails(detailRef) : undefined);
    setLoadError(null);
  }, [detailRef]);

  useEffect(() => {
    if (!open || !detailRef || details || loadError || !loadToolDetails) return;
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
  }, [detailRef, details, loadError, loadToolDetails, open]);

  // An inline result is already the whole answer; only a deferred one needs
  // anything fetched.
  if (source.toolOutput !== undefined || source.toolError !== undefined) {
    return { toolOutput: source.toolOutput, toolError: source.toolError };
  }
  if (details) {
    return { toolOutput: details.toolOutput, toolError: details.toolError };
  }
  if (loadError) return { toolError: loadError };
  if (detailRef && open) return { toolOutput: "Loading tool details…" };
  return {};
}

export function getAgentExpansionKey(part: NativeAgentActivityPart, partKey: string): string {
  if (part.type === "task-group") {
    const durableId = part.task.toolUseId?.trim() || part.task.subagentId?.trim();
    return durableId ? `task:id:${durableId}` : `task:part:${partKey}`;
  }

  const durableId = part.subagentId?.trim() || part.toolUseId?.trim();
  return durableId ? `subagent:id:${durableId}` : `subagent:part:${partKey}`;
}

export function useAgentExpansion(part: NativeAgentActivityPart, partKey: string) {
  const expansionScope = useContext(MessageExpansionScopeContext);
  const expansionKey = getAgentExpansionKey(part, partKey);
  // Active agents live in a virtualized row that can be unmounted while Claude
  // streams or while the reader scrolls. Persist the user's explicit toggle in
  // the same bounded store used by thinking/JSON disclosures so those routine
  // remounts cannot silently collapse the agent again.
  return useMessagePartExpansion(`native-agent:${expansionScope}:${expansionKey}`);
}

export function getToolExpansionKey(
  part: Extract<NativeMessagePart, { type: "tool-invocation" }>,
  partKey: string,
): string {
  const durableId = part.toolUseId?.trim() || part.sourcePartId?.trim();
  return durableId ? `id:${durableId}` : `part:${partKey}`;
}

export interface NativeMessagePartRendererProps {
  part: NativeMessagePart;
  partKey: string;
  showTextCopy?: boolean;
  truncateUserPrompt?: boolean;
  renderJsonPayload?: boolean;
  containerId?: string;
  eagerImagePreview?: boolean;
  deferredDetails?: boolean;
  embedded?: boolean;
}

export type NativeMessagePartRenderer = (props: NativeMessagePartRendererProps) => ReactNode;

export const NativeMessagePartRendererContext = createContext<
  NativeMessagePartRenderer | undefined
>(undefined);

export function NativeMessagePartRenderer(props: NativeMessagePartRendererProps) {
  const renderPart = useContext(NativeMessagePartRendererContext);
  return renderPart ? renderPart(props) : null;
}

export function stringToolArg(
  args: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!args) return undefined;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}
