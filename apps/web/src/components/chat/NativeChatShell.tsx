import { useState, type ReactNode, type RefObject } from "react";
import type { StateSnapshot, VirtuosoHandle } from "react-virtuoso";
import { AlertCircle, ArrowDown, History, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AgentThinkingIndicator } from "@/components/chat/AgentThinkingIndicator";
import { NativeComposeDock } from "@/components/chat/NativeComposeDock";
import { VirtualizedMessageList } from "@/components/chat/VirtualizedMessageList";
import { NativeMessage } from "@/components/chat/NativeMessage";
import { formatElapsed } from "@/lib/format-elapsed";
import type { NativeMessage as NativeMessageType } from "@/lib/chat/native-message-types";

export type NativeConnectionState = "connecting" | "connected" | "error";

interface NativeChatShellProps<TMessage extends NativeMessageType> {
  /** Rendered as the assistant name and used in copy: "Connecting to {label}…". */
  agentLabel: string;
  /**
   * Container the environment runs in, when Dockerised.
   *
   * Forwarded to `NativeMessage` so images the agent wrote inside the container
   * render inline. All three tabs pass it; Codex and OpenCode used not to,
   * which is why their transcripts showed bare file paths where Claude showed
   * the picture.
   */
  containerId?: string;

  connectionState: NativeConnectionState;
  errorMessage?: string | null;
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
  /** Bottom spacer height class; widen when a tall accessory is pinned. */
  bottomSpacerClassName?: string;

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
  containerId,
  connectionState,
  errorMessage,
  serverLog,
  onRetry,
  messages,
  isLoading,
  statusLabel,
  elapsedSeconds,
  finalElapsedSeconds,
  blockingCards,
  pinnedAccessory,
  bottomSpacerClassName = "h-32",
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

  if (connectionState === "connecting") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-4 text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin" />
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
              {serverLog || "(empty log)"}
            </pre>
          </div>
        )}
      </div>
    );
  }

  const hasPinnedContent = Boolean(blockingCards) || Boolean(pinnedAccessory);

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
          renderMessage={(_index, message, previous) => (
            <NativeMessage
              message={message}
              previousMessage={previous}
              assistantLabel={agentLabel}
              containerId={containerId}
            />
          )}
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
              <div className={bottomSpacerClassName} aria-hidden="true" />
            </>
          }
          scrollProps={scrollProps}
          virtuosoRef={virtuosoRef}
        />
      </div>

      <NativeComposeDock
        centered={centerCompose}
        pinnedContent={
          hasPinnedContent ? (
            <>
              {blockingCards}
              {pinnedAccessory}
            </>
          ) : null
        }
        topAccessory={
          !isAtBottom ? (
            <button
              type="button"
              onClick={scrollToBottom}
              className="flex items-center gap-1.5 rounded-full bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 shadow-sm transition-colors hover:bg-zinc-700"
              aria-label="Scroll to bottom of conversation"
            >
              <ArrowDown className="h-3.5 w-3.5" />
              <span>Scroll down</span>
            </button>
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
