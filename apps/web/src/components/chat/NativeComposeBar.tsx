import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { AlertCircle, ArrowUp, FileText, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContextUsageWheel } from "@/components/chat/ContextUsageWheel";
import {
  COMPOSE_MAX_INPUT_HEIGHT,
  COMPOSE_MIN_INPUT_HEIGHT,
} from "@/components/chat/compose-metrics";
import { MentionableInput, type MentionableInputRef } from "@/components/chat/MentionableInput";
import { cn } from "@/lib/utils";
import type { ContextUsageSnapshot } from "@/lib/context-usage";
import type { FileMention } from "@/types";

export interface NativeComposeAttachment {
  id: string;
  type: "file" | "image";
  name: string;
  path: string;
  previewUrl?: string;
}

export interface NativeComposeQueueState {
  length: number;
  error?: { message: string } | null;
  onOpen: () => void;
}

export interface NativeComposeBarProps {
  testId?: string;
  layout?: "bottom" | "centered";
  attachments: readonly NativeComposeAttachment[];
  onRemoveAttachment: (id: string) => void;
  inputRef: RefObject<MentionableInputRef | null>;
  inputContainerRef: RefObject<HTMLDivElement | null>;
  text: string;
  mentions: FileMention[];
  onTextAndMentionsChange: (text: string, mentions: FileMention[]) => void;
  onCursorPositionChange: (position: number, text: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  placeholder: string;
  disabled?: boolean;
  isSending?: boolean;
  isLoading?: boolean;
  menus?: ReactNode;
  primaryControls: ReactNode;
  contextUsage?: ContextUsageSnapshot | null;
  showContextUsage?: boolean;
  queue?: NativeComposeQueueState;
  onStop?: () => void | Promise<void>;
  showAddressAll?: boolean;
  onAddressAll?: () => void | Promise<void>;
  showSendButton?: boolean;
  sendDisabled?: boolean;
  sendTitle?: string;
  onSend: () => void | Promise<void>;
  footer?: ReactNode;
}

/**
 * The only visual composer used by native agents.
 *
 * Provider runtimes supply neutral state and intents. This component does not
 * know how Claude, Codex, or OpenCode encode a prompt or model selection.
 */
export function NativeComposeBar({
  testId,
  layout = "bottom",
  attachments,
  onRemoveAttachment,
  inputRef,
  inputContainerRef,
  text,
  mentions,
  onTextAndMentionsChange,
  onCursorPositionChange,
  onKeyDown,
  placeholder,
  disabled = false,
  isSending = false,
  isLoading = false,
  menus,
  primaryControls,
  contextUsage,
  showContextUsage = true,
  queue,
  onStop,
  showAddressAll = false,
  onAddressAll,
  showSendButton = true,
  sendDisabled = false,
  sendTitle,
  onSend,
  footer,
}: NativeComposeBarProps) {
  return (
    <>
      <div
        data-testid={testId}
        className={cn(
          "mx-auto w-[calc(100%_-_0.75rem)] shrink-0 rounded-2xl border border-border/70 bg-zinc-900/90 p-3 shadow-xl shadow-black/20 sm:w-[min(calc(100%_-_2rem),56rem)]",
          layout === "bottom" ? "mb-4 mt-2" : "my-0",
        )}
      >
        {attachments.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <div
                key={attachment.id}
                className="group relative flex items-center gap-1.5 rounded border border-border bg-muted/50 px-2 py-1 text-xs"
              >
                {attachment.type === "image" && attachment.previewUrl ? (
                  <img
                    src={attachment.previewUrl}
                    alt={attachment.name}
                    className="h-6 w-6 rounded object-cover"
                  />
                ) : (
                  <FileText className="h-4 w-4 text-muted-foreground" />
                )}
                <span className="max-w-[120px] truncate">{attachment.name}</span>
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(attachment.id)}
                  disabled={disabled || isSending}
                  className="ml-1 rounded-full p-0.5 hover:bg-muted"
                  aria-label={`Remove ${attachment.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <div className="relative" data-mentionable-input ref={inputContainerRef}>
          {menus}
          <MentionableInput
            ref={inputRef}
            value={text}
            mentions={mentions}
            onChange={onTextAndMentionsChange}
            onCursorChange={onCursorPositionChange}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            disabled={disabled || isSending}
            minHeight={COMPOSE_MIN_INPUT_HEIGHT}
            maxHeight={COMPOSE_MAX_INPUT_HEIGHT}
            className={cn((disabled || isSending) && "opacity-60")}
          />
        </div>

        <div
          data-native-compose-toolbar
          className="flex min-w-0 items-center gap-1 overflow-x-auto pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <div
            data-native-compose-controls="primary"
            className="flex min-w-0 flex-1 items-center gap-1"
          >
            {primaryControls}
          </div>

          <div
            data-native-compose-controls="secondary"
            className="flex shrink-0 items-center gap-1"
          >
            {queue && queue.length > 0 ? (
              <button
                type="button"
                onClick={queue.onOpen}
                className={cn(
                  "flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors",
                  queue.error
                    ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
                    : "bg-muted/50 text-muted-foreground hover:bg-muted",
                )}
                aria-label={
                  queue.error
                    ? `${queue.length} queued prompts blocked: ${queue.error.message}`
                    : undefined
                }
                title={
                  queue.error
                    ? `Queued prompt was not sent: ${queue.error.message}`
                    : "View queued prompts"
                }
              >
                {queue.error ? (
                  <AlertCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
                ) : null}
                <span>+{queue.length} queued</span>
              </button>
            ) : null}

            {showContextUsage && contextUsage != null ? (
              <ContextUsageWheel usage={contextUsage} className="ml-1" />
            ) : null}

            {isLoading ? (
              <button
                type="button"
                onClick={() => void onStop?.()}
                disabled={disabled || !onStop}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-destructive/10 text-destructive transition-colors hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-50"
                title="Stop current query"
              >
                <Square className="h-4 w-4 fill-current" />
              </button>
            ) : null}

            {showAddressAll && !isLoading ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void onAddressAll?.()}
                disabled={disabled || isSending || !onAddressAll}
                className="h-8 rounded-full px-3 text-xs"
                title="Send the review follow-up prompt"
              >
                Address all
              </Button>
            ) : null}

            {showSendButton ? (
              <Button
                type="button"
                size="icon"
                className={cn(
                  "h-8 w-8 rounded-full text-foreground transition-colors",
                  isLoading
                    ? "bg-primary/20 text-primary hover:bg-primary/30"
                    : "bg-muted hover:bg-muted/80",
                )}
                disabled={sendDisabled}
                onClick={() => void onSend()}
                title={sendTitle ?? (isLoading ? "Add to queue" : "Send message")}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      {footer}
    </>
  );
}
