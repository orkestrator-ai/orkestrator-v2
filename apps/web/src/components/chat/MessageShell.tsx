import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface MessageShellProps {
  isUser: boolean;
  authorLabel: string;
  timestampLabel: string;
  durationLabel?: string | null;
  showHeader?: boolean;
  className?: string;
  contentClassName?: string;
  actions?: ReactNode;
  onUserLongPress?: () => void | Promise<void>;
  children: ReactNode;
}

const LONG_PRESS_DELAY_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

export function MessageShell({
  isUser,
  authorLabel,
  timestampLabel,
  durationLabel,
  showHeader = true,
  className,
  contentClassName,
  actions,
  onUserLongPress,
  children,
}: MessageShellProps) {
  const metadata = [timestampLabel, durationLabel].filter(Boolean).join(" · ");
  const showUserActionRow = isUser && (metadata || actions);
  const showAssistantActionRow = !isUser && (metadata || actions);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);
  const longPressReadyRef = useRef(false);
  const suppressNextClickRef = useRef(false);

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressStartRef.current = null;
    longPressReadyRef.current = false;
  }, []);

  useEffect(() => cancelLongPress, [cancelLongPress]);

  const handleUserPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      suppressNextClickRef.current = false;
      if (!onUserLongPress || event.pointerType !== "touch" || !event.isPrimary) {
        return;
      }

      cancelLongPress();
      longPressStartRef.current = { x: event.clientX, y: event.clientY };
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTimerRef.current = null;
        longPressReadyRef.current = true;
      }, LONG_PRESS_DELAY_MS);
    },
    [cancelLongPress, onUserLongPress],
  );

  const handleUserPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const start = longPressStartRef.current;
    if (!start) return;

    if (
      Math.abs(event.clientX - start.x) > LONG_PRESS_MOVE_TOLERANCE_PX ||
      Math.abs(event.clientY - start.y) > LONG_PRESS_MOVE_TOLERANCE_PX
    ) {
      cancelLongPress();
    }
  }, [cancelLongPress]);

  const handleUserPointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const shouldCopy = event.pointerType === "touch" && longPressReadyRef.current;
    cancelLongPress();
    if (shouldCopy) {
      suppressNextClickRef.current = true;
      void onUserLongPress?.();
    }
  }, [cancelLongPress, onUserLongPress]);

  const handleUserClickCapture = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (!suppressNextClickRef.current) return;
    suppressNextClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return (
    <div
      className={cn(
        "px-3 @sm:px-6 py-3",
        className,
      )}
    >
      <div
        className={cn(
          "mx-auto flex max-w-3xl min-w-0",
          isUser ? "justify-end" : "justify-start",
          contentClassName,
        )}
      >
        <div className={cn("group min-w-0 break-words", isUser ? "max-w-[82%]" : "w-full")}>
          <div
            className={cn(
              "min-w-0 break-words",
              isUser
                ? "rounded-xl border border-border/70 bg-zinc-800/80 px-3.5 py-1.5 shadow-sm [&_.prose_p]:my-0"
                : "w-full",
            )}
            onPointerDown={isUser ? handleUserPointerDown : undefined}
            onPointerMove={isUser ? handleUserPointerMove : undefined}
            onPointerUp={isUser ? handleUserPointerUp : undefined}
            onPointerCancel={isUser ? cancelLongPress : undefined}
            onClickCapture={isUser ? handleUserClickCapture : undefined}
            style={
              isUser && onUserLongPress
                ? { WebkitTouchCallout: "none", touchAction: "pan-y" }
                : undefined
            }
          >
            {showHeader && isUser ? (
              <div className="sr-only">
                {authorLabel}
              </div>
            ) : null}

            <div className="flex flex-col gap-3 break-words">{children}</div>

            {showAssistantActionRow ? (
              <div className="mt-1 flex min-h-6 items-center justify-between gap-3 text-[10px] leading-none text-muted-foreground/55">
                {metadata ? (
                  <div className="min-w-0 truncate text-left">
                    <span className="font-medium text-muted-foreground/70">
                      {authorLabel}
                    </span>
                    <span className="mx-1.5">·</span>
                    <span>{metadata}</span>
                  </div>
                ) : <span />}
                {actions ? (
                  <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
                    {actions}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          {showUserActionRow ? (
            <div
              className={cn(
                "mt-1 flex min-h-6 items-center justify-end gap-2 text-[10px] leading-none text-muted-foreground/55",
                "opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100",
              )}
            >
              {metadata ? <span>{metadata}</span> : null}
              {actions ? (
                <div className="flex items-center gap-1">
                  {actions}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

interface MessageErrorAlertProps {
  content: string;
  timestampLabel: string;
  details?: string;
  action?: ReactNode;
}

export function MessageErrorAlert({
  content,
  timestampLabel,
  details,
  action,
}: MessageErrorAlertProps) {
  return (
    <div className="px-2 @sm:px-4 py-3">
      <div className="max-w-3xl mx-auto min-w-0">
        <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/20">
          <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-sm text-destructive whitespace-pre-wrap break-words">
              {content}
            </div>
            {details ? (
              <div className="text-xs text-destructive/75 whitespace-pre-wrap break-words mt-2">
                {details}
              </div>
            ) : null}
            {action ? <div className="mt-3">{action}</div> : null}
            <div className="text-[10px] text-destructive/60 mt-1">
              {timestampLabel}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
