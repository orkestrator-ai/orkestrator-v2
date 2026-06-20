import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface NativeComposeDockProps {
  centered: boolean;
  children: ReactNode;
  actions?: ReactNode;
  topAccessory?: ReactNode;
  title?: string;
}

export function NativeComposeDock({
  centered,
  children,
  actions,
  topAccessory,
  title = "Ready to build!",
}: NativeComposeDockProps) {
  return (
    <div
      data-testid="compose-dock"
      className={cn(
        "absolute inset-x-0 z-20 px-4 transition-[top,transform] duration-300 ease-out motion-reduce:transition-none",
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
          <h2 className="text-2xl font-bold text-white">{title}</h2>
        </div>

        {topAccessory && !centered ? (
          <div className="pointer-events-auto mx-auto mb-1 flex w-[min(calc(100%_-_2rem),56rem)] justify-end">
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
