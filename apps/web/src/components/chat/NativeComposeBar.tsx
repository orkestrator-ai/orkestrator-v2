import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { AlertCircle, ArrowUp, FileText, MessageSquareText, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  COMPOSE_MAX_INPUT_HEIGHT,
  COMPOSE_MIN_INPUT_HEIGHT,
} from "@/components/chat/compose-metrics";
import { MentionableInput, type MentionableInputRef } from "@/components/chat/MentionableInput";
import { cn } from "@/lib/utils";
import type { FileMention } from "@/types";
import type { TranscriptAnnotation } from "@/lib/chat/transcript-annotations";

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
  annotations?: readonly TranscriptAnnotation[];
  onClearAnnotations?: () => void;
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
  annotations = [],
  onClearAnnotations,
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
          "mx-auto w-[calc(100%_-_0.75rem)] shrink-0 rounded-xl border border-border/70 bg-input-surface p-3 shadow-xl shadow-black/20 sm:w-[min(calc(100%_-_2rem),56rem)]",
          layout === "bottom" ? "mb-4 mt-2" : "my-0",
        )}
      >
        {attachments.length > 0 || annotations.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-2">
            {annotations.length > 0 ? (
              <Tooltip delayDuration={250}>
                <TooltipTrigger asChild>
                  <div
                    data-testid="compose-annotation-count"
                    className="flex h-9 items-center gap-1.5 rounded-full border border-blue-400/30 bg-blue-500/10 px-3 text-sm text-blue-100 shadow-[inset_0_0_0_1px_rgba(59,130,246,0.04)]"
                  >
                    <MessageSquareText className="h-4 w-4 text-blue-300" aria-hidden="true" />
                    <span>
                      {annotations.length} annotation{annotations.length === 1 ? "" : "s"}
                    </span>
                    {onClearAnnotations ? (
                      <button
                        type="button"
                        onClick={onClearAnnotations}
                        disabled={disabled || isSending}
                        className="-mr-1 ml-0.5 rounded-full p-0.5 text-blue-200/70 transition-colors hover:bg-blue-400/15 hover:text-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label="Remove all transcript annotations"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </div>
                </TooltipTrigger>
                <TooltipContent
                  side="top"
                  align="start"
                  sideOffset={8}
                  className="w-[min(28rem,calc(100vw-2rem))] max-w-none p-4 text-left text-sm text-pretty"
                >
                  <ol className="space-y-3">
                    {annotations.map((annotation, index) => (
                      <li
                        key={annotation.id}
                        className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2"
                      >
                        <span className="text-muted-foreground">{index + 1}.</span>
                        <div className="min-w-0 space-y-1.5">
                          <div>
                            <p className="text-xs font-medium text-muted-foreground">
                              Selected text
                            </p>
                            <p className="mt-0.5 max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-foreground">
                              {annotation.text}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs font-medium text-muted-foreground">
                              User comment
                            </p>
                            <p className="mt-0.5 whitespace-pre-wrap break-words text-foreground">
                              {annotation.comment.trim() || "No comment added"}
                            </p>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ol>
                </TooltipContent>
              </Tooltip>
            ) : null}
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
          className="flex min-w-0 items-center gap-1 overflow-x-auto pt-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
                  "flex h-7 items-center gap-1 rounded-lg px-2 text-xs transition-colors",
                  queue.error
                    ? "bg-destructive/15 text-destructive hover:bg-destructive/25"
                    : "bg-elevated text-muted-foreground hover:bg-elevated-hover hover:text-foreground",
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

            {isLoading ? (
              <button
                type="button"
                onClick={() => void onStop?.()}
                disabled={disabled || !onStop}
                className="flex h-7 w-7 items-center justify-center rounded-lg bg-destructive text-white transition-colors hover:bg-destructive/85 disabled:cursor-not-allowed disabled:opacity-50"
                title="Stop current query"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
              </button>
            ) : null}

            {showAddressAll && !isLoading ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void onAddressAll?.()}
                disabled={disabled || isSending || !onAddressAll}
                className="h-7 rounded-lg px-3 text-xs"
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
                  "h-7 w-7 rounded-lg transition-colors",
                  /*
                    Queueing is still a send, so it keeps the send button's
                    shape and colour and only steps back in weight — a
                    different-coloured control here reads as a different action.
                  */
                  isLoading
                    ? "bg-primary/25 text-blue-200 hover:bg-primary/40"
                    : "bg-primary text-primary-foreground hover:bg-primary/85",
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
