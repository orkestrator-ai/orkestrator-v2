import {
  createContext,
  useCallback,
  useContext,
  type AnchorHTMLAttributes,
  type ReactNode,
} from "react";
import { openInBrowser } from "@/lib/backend";
import { type Components } from "react-markdown";
import {
  type NativeAgentActivityPart,
  type NativeMessage as NativeMessageType,
  type NativeMessagePart,
} from "@/lib/chat/native-message-types";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { NativeAgentToolDetails } from "@orkestrator/protocol/native-agent";
import { useMessagePartExpansion } from "@/lib/chat/message-part-expansion";

function ExternalLink({
  href,
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault();
      if (href) {
        openInBrowser(href).catch((err) => {
          console.error("[NativeMessage] Failed to open link:", err);
        });
      }
    },
    [href],
  );

  return (
    <a
      href={href}
      onClick={handleClick}
      className="text-primary hover:underline cursor-pointer"
      {...props}
    >
      {children}
    </a>
  );
}

/** Markdown components config with external link handling */
export const markdownComponents: Components = {
  a: ExternalLink,
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
}

export const MessageExpansionScopeContext = createContext("native-message");
export const AgentPlatformContext = createContext<AgentPlatform | undefined>(undefined);
export const ToolDetailLoaderContext = createContext<
  ((detailRef: string) => Promise<NativeAgentToolDetails>) | undefined
>(undefined);
const TOOL_DETAIL_BROWSER_CACHE_MAX_ENTRIES = 256;
const TOOL_DETAIL_BROWSER_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const toolDetailBrowserCache = new Map<string, {
  details: NativeAgentToolDetails;
  bytes: number;
}>();
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
    toolDetailBrowserCache.size > TOOL_DETAIL_BROWSER_CACHE_MAX_ENTRIES
    || toolDetailBrowserCacheBytes > TOOL_DETAIL_BROWSER_CACHE_MAX_BYTES
  ) {
    const oldest = toolDetailBrowserCache.keys().next().value;
    if (!oldest) break;
    const entry = toolDetailBrowserCache.get(oldest);
    if (entry) toolDetailBrowserCacheBytes -= entry.bytes;
    toolDetailBrowserCache.delete(oldest);
  }
}

export function getAgentExpansionKey(
  part: NativeAgentActivityPart,
  partKey: string,
): string {
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
  return useMessagePartExpansion(
    `native-agent:${expansionScope}:${expansionKey}`,
  );
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

export type NativeMessagePartRenderer = (
  props: NativeMessagePartRendererProps,
) => ReactNode;

export const NativeMessagePartRendererContext =
  createContext<NativeMessagePartRenderer | undefined>(undefined);

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
