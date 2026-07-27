import type { ReactNode, Ref } from "react";
import { cn } from "@/lib/utils";

interface NativeComposeDockProps {
  centered: boolean;
  children: ReactNode;
  actions?: ReactNode;
  /** Hidden while centered — for affordances that only make sense in a scrolled transcript. */
  topAccessory?: ReactNode;
  /**
   * Always visible, in both centered and docked layouts.
   *
   * For content the turn is blocked on: an approval can arrive before the
   * transcript has any messages, which is exactly when the composer is
   * centered, so gating it on `!centered` would hide the prompt the user has
   * to answer.
   */
  pinnedContent?: ReactNode;
  title?: string;
  /** Root element, used by the chat shell to reserve the dock's rendered height. */
  rootRef?: Ref<HTMLDivElement>;
}

export function NativeComposeDock({
  centered,
  children,
  actions,
  topAccessory,
  pinnedContent,
  title = "Ready to build!",
  rootRef,
}: NativeComposeDockProps) {
  return (
    <div
      ref={rootRef}
      data-testid="compose-dock"
      className={cn(
        "absolute inset-x-0 z-20 px-2 transition-[top,transform] duration-300 ease-out motion-reduce:transition-none sm:px-4",
        centered ? "top-1/2 -translate-y-1/2" : "top-full -translate-y-full",
      )}
    >
      <div className={cn("flex flex-col items-center", centered ? "gap-4" : "gap-0")}>
        <div
          className={cn(
            "overflow-hidden text-center transition-[max-height,opacity,transform] duration-300 ease-out motion-reduce:transition-none",
            centered
              ? "max-h-16 translate-y-0 opacity-100"
              : "max-h-0 -translate-y-2 opacity-0",
          )}
        >
          <h2 className="text-xl font-bold text-white sm:text-2xl">{title}</h2>
        </div>

        {pinnedContent ? (
          /**
           * Bounded and scrollable: the dock is an absolute overlay anchored to
           * the bottom of an `overflow-hidden` root, so an unbounded card grows
           * upward past the top and is clipped with no way to reach it — while
           * the turn stays blocked on the prompt inside it.
           */
          <div className="pointer-events-auto mx-auto mb-1 flex max-h-[60vh] w-full max-w-[56rem] flex-col gap-2 overflow-y-auto sm:w-[min(calc(100%_-_2rem),56rem)]">
            {pinnedContent}
          </div>
        ) : null}

        {topAccessory && !centered ? (
          <div className="pointer-events-auto mx-auto mb-1 flex w-full max-w-[56rem] justify-end sm:w-[min(calc(100%_-_2rem),56rem)]">
            {topAccessory}
          </div>
        ) : null}

        {children}

        {actions ? (
          <div
            className={cn(
              "overflow-hidden transition-[max-height,opacity,transform] duration-300 ease-out motion-reduce:transition-none",
              centered
                ? "max-h-12 translate-y-0 opacity-100"
                : "max-h-0 -translate-y-2 opacity-0",
            )}
          >
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}
