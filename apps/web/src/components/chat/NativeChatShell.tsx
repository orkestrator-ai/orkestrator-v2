import {
  Children,
  useCallback,
  useLayoutEffect,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { StateSnapshot, VirtuosoHandle } from "react-virtuoso";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { AlertCircle, ArrowDown, History, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AgentThinkingIndicator } from "@/components/chat/AgentThinkingIndicator";
import { AgentPlatformIcon } from "@/components/icons/AgentIcons";
import { NativeComposeDock } from "@/components/chat/NativeComposeDock";
import { VirtualizedMessageList } from "@/components/chat/VirtualizedMessageList";
import { NativeMessage } from "@/components/chat/NativeMessage";
import { getNativeMessageSearchText } from "@/components/chat/native-message-search";
import { formatElapsed } from "@/lib/format-elapsed";
import type { NativeMessage as NativeMessageType } from "@/lib/chat/native-message-types";
import { findPreviousNativeMessage } from "@/lib/chat/native-message-adapters";

export type NativeConnectionState = "connecting" | "connected" | "error";

interface NativeChatShellProps<TMessage extends NativeMessageType> {
  /** Rendered as the assistant name and used in copy: "Connecting to {label}…". */
  agentLabel: string;
  /** Brand mark shown on the connecting screen instead of a generic spinner. */
  platform: AgentPlatform;
  /** Only the focused chat pane owns global keyboard shortcuts. */
  isActive: boolean;
  /** Split panes can both be active; only the focused pane owns find shortcuts. */
  ownsGlobalShortcuts?: boolean;
  /**
   * Container the environment runs in, when Dockerised.
   *
   * Forwarded to `NativeMessage` so images the agent wrote inside the container
   * render inline. All three tabs pass it; Codex and OpenCode used not to,
   * which is why their transcripts showed bare file paths where Claude showed
   * the picture.
   */
  containerId?: string;
  /** Stable environment/session identity for persisted message disclosures. */
  agentExpansionScope: string;

  connectionState: NativeConnectionState;
  errorMessage?: string | null;
  desynced?: boolean;
  serverLog?: string | null;
  onRetry: () => void;

  messages: TMessage[];
  isLoading: boolean;
  /**
   * Replaces the thinking indicator when the turn is in a distinct phase
   * (Codex's "Stopping…" / "Reconnecting…").
   */
  statusLabel?: ReactNode;
  elapsedSeconds: number | null;
  finalElapsedSeconds: number | null;

  /**
   * Approvals, questions and permission prompts — anything the turn is blocked
   * on. Pinned directly above the composer rather than placed in the message
   * list: the turn cannot proceed until the user answers, so they must be
   * visible without scrolling and must not move as messages stream in.
   */
  blockingCards?: ReactNode;
  /** Extra pinned content below the blocking cards, e.g. Codex's plan card. */
  pinnedAccessory?: ReactNode;
  /** Rendered above the oldest message, e.g. "load earlier messages". */
  transcriptHeader?: ReactNode;
  /** Bottom spacer height class; widen when a tall accessory is pinned. */
  bottomSpacerClassName?: string;
  /**
   * Per-message hover actions, e.g. "fork from here".
   *
   * Must be referentially stable per message id or `memo(NativeMessage)` stops
   * holding and every visible message rerenders on each streamed frame.
   */
  messageActions?: (message: TMessage) => ReactNode;
  /** Maps a backend-confirmed id to the friendly name from this tab's catalog. */
  resolveModelLabel?: (modelId: string) => string;
  /**
   * Extra content in the dock's top strip, beside the scroll-to-bottom button
   * — Claude's prompt-suggestion chip.
   */
  topAccessory?: ReactNode;

  centerCompose: boolean;
  composer: ReactNode;
  /** Rendered outside the dock, so its portal is not clipped. */
  resumeDialog?: ReactNode;
  onResumeClick?: () => void;
  emptyStateMessage?: string;

  isAtBottom: boolean;
  scrollToBottom: () => void;
  scrollProps: {
    followOutput: (isAtBottom: boolean) => "auto" | false;
    atBottomStateChange: (atBottom: boolean) => void;
    atBottomThreshold: number;
    totalListHeightChanged?: (height: number) => void;
    restoreStateFrom: StateSnapshot | undefined;
    scrollerRef?: (el: HTMLElement | Window | null) => void;
  };
  virtuosoRef: RefObject<VirtuosoHandle | null>;
}

/**
 * The frame every native chat tab renders inside.
 *
 * Claude, Codex and OpenCode each had their own copy of this tree, and they had
 * drifted on the parts that are not agent-specific at all: where blocking
 * prompts appear, whether there is an empty state, whether the error screen has
 * a log toggle, whether inline images work. Everything genuinely per-agent —
 * the composer, the cards, the resume dialog — is passed in.
 */
export function NativeChatShell<TMessage extends NativeMessageType>({
  agentLabel,
  platform,
  isActive,
  ownsGlobalShortcuts,
  containerId,
  agentExpansionScope,
  connectionState,
  errorMessage,
  desynced = false,
  serverLog,
  onRetry,
  messages,
  isLoading,
  statusLabel,
  elapsedSeconds,
  finalElapsedSeconds,
  blockingCards,
  pinnedAccessory,
  transcriptHeader,
  bottomSpacerClassName = "h-32",
  messageActions,
  resolveModelLabel,
  topAccessory,
  centerCompose,
  composer,
  resumeDialog,
  onResumeClick,
  emptyStateMessage,
  isAtBottom,
  scrollToBottom,
  scrollProps,
  virtuosoRef,
}: NativeChatShellProps<TMessage>) {
  const [showLog, setShowLog] = useState(false);
  const [composeDockElement, setComposeDockElement] =
    useState<HTMLDivElement | null>(null);
  const [composeDockHeight, setComposeDockHeight] = useState<number | null>(null);
  const composeDockRef = useCallback((element: HTMLDivElement | null) => {
    setComposeDockElement(element);
  }, []);

  useLayoutEffect(() => {
    // The dock is rendered unconditionally, so a null element only ever means
    // the shell is unmounting: nothing to measure and nothing worth resetting.
    if (!composeDockElement) return;

    const syncHeight = () => {
      const nextHeight = Math.ceil(composeDockElement.getBoundingClientRect().height);
      setComposeDockHeight((currentHeight) =>
        currentHeight === nextHeight ? currentHeight : nextHeight,
      );
    };

    syncHeight();
    window.addEventListener("resize", syncHeight);

    if (typeof ResizeObserver === "undefined") {
      return () => window.removeEventListener("resize", syncHeight);
    }

    const resizeObserver = new ResizeObserver(syncHeight);
    resizeObserver.observe(composeDockElement);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", syncHeight);
    };
  }, [composeDockElement]);

  if (connectionState === "connecting") {
    return (
      <div
        role="status"
        className="flex h-full flex-col items-center justify-center gap-4 p-4 text-muted-foreground"
      >
        <span aria-hidden="true">
          <AgentPlatformIcon
            platform={platform}
            className="agent-connecting-logo h-16 w-16"
          />
        </span>
        <p className="text-sm">Connecting to {agentLabel}...</p>
      </div>
    );
  }

  if (connectionState === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-4 text-muted-foreground">
        <AlertCircle className="h-10 w-10 text-destructive" />
        <div className="text-center">
          <p className="text-sm font-medium text-foreground">Connection Failed</p>
          <p className="mt-1 max-w-lg text-left text-xs break-words whitespace-pre-wrap">
            {errorMessage || `Unable to connect to ${agentLabel}`}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onRetry} className="gap-2">
            <RefreshCw className="h-4 w-4" />
            Retry
          </Button>
          {serverLog && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowLog((value) => !value)}
            >
              {showLog ? "Hide Log" : "Show Log"}
            </Button>
          )}
        </div>
        {showLog && serverLog && (
          <div className="mt-2 w-full max-w-lg">
            <pre className="max-h-48 overflow-auto rounded-md bg-muted p-3 text-left text-xs whitespace-pre-wrap">
              {/* A whitespace-only log is truthy, so say so rather than
                  opening an empty box the user cannot interpret. */}
              {serverLog.trim() ? serverLog : "(empty log)"}
            </pre>
          </div>
        )}
      </div>
    );
  }

  /**
   * Counted, not coerced. The natural thing to pass is a `.map()` result, and
   * an empty array is truthy — `Boolean([])` would render the empty pinned
   * wrapper and permanently switch the spacer to dock-height mode for a tab
   * that has no blocking prompt at all.
   */
  const hasPinnedContent =
    Children.count(blockingCards) > 0 || Children.count(pinnedAccessory) > 0;

  /**
   * A measured height of 0 means the dock has not laid out yet (first paint, a
   * hidden tab), so pinned content still needs the conservative reservation
   * rather than a spacer that clears nothing.
   */
  const measuredDockHeight =
    composeDockHeight !== null && composeDockHeight > 0 ? composeDockHeight : null;

  return (
    <div className="@container relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none",
          centerCompose && "pointer-events-none scale-[0.995] opacity-0",
        )}
      >
        <VirtualizedMessageList
          messages={messages}
          computeItemKey={(_index, message) => message.id}
          resolvePreviousMessage={findPreviousNativeMessage}
          renderMessage={(_index, message, previous) => (
            <NativeMessage
              message={message}
              previousMessage={previous}
              assistantLabel={agentLabel}
              containerId={containerId}
              agentExpansionScope={agentExpansionScope}
              actions={messageActions?.(message)}
              resolveModelLabel={resolveModelLabel}
            />
          )}
          header={transcriptHeader}
          emptyState={
            !centerCompose ? (
              <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-3 text-muted-foreground">
                <p className="text-sm">
                  {emptyStateMessage
                    ?? `No messages yet. Start a conversation with ${agentLabel}!`}
                </p>
                {onResumeClick && (
                  <Button variant="outline" size="sm" onClick={onResumeClick}>
                    <History className="mr-2 h-4 w-4" />
                    Resume Session
                  </Button>
                )}
              </div>
            ) : undefined
          }
          footer={
            <>
              {isLoading && (
                <div className="px-2 @sm:px-4">
                  <div className="chat-status-row mx-auto max-w-3xl min-w-0">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      {statusLabel ?? (
                        <AgentThinkingIndicator agentName={agentLabel} />
                      )}
                      {elapsedSeconds !== null && elapsedSeconds > 0 && (
                        <span className="text-xs text-muted-foreground/50">
                          {formatElapsed(elapsedSeconds)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {!isLoading && finalElapsedSeconds !== null && (
                <div className="px-2 @sm:px-4">
                  <div className="chat-status-row mx-auto max-w-3xl min-w-0">
                    <span className="text-[10px] text-muted-foreground/40">
                      Completed in {formatElapsed(finalElapsedSeconds)}
                    </span>
                  </div>
                </div>
              )}
              {/*
                The dock floats over the transcript, so its full live height must
                be reserved here. That keeps a growing composer — plus any pinned
                cards — from covering the last messages.
              */}
              <div
                data-testid="transcript-bottom-spacer"
                className={cn(
                  "shrink-0",
                  measuredDockHeight === null
                    ? hasPinnedContent
                      ? "h-80"
                      : bottomSpacerClassName
                    : undefined,
                )}
                style={
                  measuredDockHeight !== null
                    ? { height: measuredDockHeight }
                    : undefined
                }
                aria-hidden="true"
              />
            </>
          }
          scrollProps={scrollProps}
          virtuosoRef={virtuosoRef}
          find={{
            isActive: ownsGlobalShortcuts ?? isActive,
            getSearchText: getNativeMessageSearchText,
          }}
        />
      </div>

      <NativeComposeDock
        rootRef={composeDockRef}
        centered={centerCompose}
        pinnedContent={
          hasPinnedContent ? (
            <>
              {blockingCards}
              {pinnedAccessory}
            </>
          ) : null
        }
        /*
         * The desync banner gets its own always-visible row rather than sharing
         * the top strip: `topAccessory` is suppressed while the composer is
         * centered, and a tab that never received a message is centered — which
         * is exactly the state a desynced tab is in.
         */
        notice={
          desynced ? (
            <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <AlertCircle className="h-4 w-4 shrink-0" />
              Live updates disconnected. A full session refresh will run when the connection returns.
            </div>
          ) : null
        }
        topAccessory={
          topAccessory || !isAtBottom ? (
            <div className="flex min-w-0 items-center gap-2">
              {topAccessory}
              {!isAtBottom ? (
                <button
                  type="button"
                  onClick={scrollToBottom}
                  className="flex shrink-0 items-center gap-1.5 rounded-full bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 shadow-sm transition-colors hover:bg-zinc-700"
                  aria-label="Scroll to bottom of conversation"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                  <span>Scroll down</span>
                </button>
              ) : null}
            </div>
          ) : null
        }
        actions={
          onResumeClick ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onResumeClick}
              className="rounded-full text-muted-foreground transition-colors hover:text-foreground"
              aria-hidden={!centerCompose}
              tabIndex={centerCompose ? 0 : -1}
            >
              <History className="mr-2 h-4 w-4" />
              Resume Session
            </Button>
          ) : null
        }
      >
        {composer}
      </NativeComposeDock>

      {resumeDialog}
    </div>
  );
}
