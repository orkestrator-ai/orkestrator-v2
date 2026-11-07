import { useShallow } from "zustand/react/shallow";
import { focusTabLaunch } from "@/lib/tab-launch";
import { useNodeScope } from "@/lib/node-scope/providers";
import { cn } from "@/lib/utils";
import { createPaneTabElementId } from "@/types/paneLayout";
import { useTabLaunchStore, type TabLaunch, type TabLaunchSurface } from "@/stores/tabLaunchStore";
import { TAB_STRIP_CLASS, TabShell } from "./TabShell";

const NO_LAUNCHES: readonly TabLaunch[] = [];

/** This environment's launches, re-read only when they change. */
export function useEnvironmentTabLaunches(environmentId: string): readonly TabLaunch[] {
  return useTabLaunchStore(useShallow((state) => state.launches.get(environmentId) ?? NO_LAUNCHES));
}

const OUTLINE_ROWS: Record<TabLaunchSurface, readonly string[]> = {
  agent: ["w-3/4", "w-full", "w-1/2"],
  terminal: ["w-1/2", "w-2/3", "w-1/3"],
  page: ["w-full", "w-5/6", "w-2/3", "w-3/4"],
};

/**
 * The outlines of a tab that is on its way: rows of output, and the composer
 * below them for an agent. Decorative, so the live tab announces itself when it
 * arrives.
 */
export function TabLaunchShimmer({ surface = "agent" }: { surface?: TabLaunchSurface }) {
  return (
    <div
      className="absolute inset-0 z-[15] flex flex-col bg-background"
      data-testid="tab-launch-shimmer"
      data-surface={surface}
      aria-hidden="true"
    >
      <div
        className={cn(
          "session-refresh-shimmer flex w-full flex-1 flex-col gap-3 py-6",
          surface === "terminal" ? "px-4" : "mx-auto max-w-3xl px-4",
        )}
      >
        {OUTLINE_ROWS[surface].map((width) => (
          <div key={width} className={cn("h-2 rounded-full bg-muted-foreground/10", width)} />
        ))}
      </div>
      {surface === "agent" && (
        <div className="session-refresh-shimmer mx-auto w-full max-w-3xl px-4 pb-4">
          <div className="h-20 w-full rounded-lg border border-border/60 bg-muted-foreground/5" />
        </div>
      )}
    </div>
  );
}

/** A launched tab in the strip, until the real one takes its place. */
export function TabLaunchPlaceholder({
  environmentId,
  paneId,
  launch,
  isPaneFocused,
}: {
  environmentId: string;
  paneId: string;
  launch: TabLaunch;
  isPaneFocused: boolean;
}) {
  const launchScope = useNodeScope();
  return (
    <TabShell
      id={createPaneTabElementId(environmentId, paneId, launch.tabId)}
      role="tab"
      tabIndex={0}
      aria-selected={launch.focused}
      isActive={launch.focused}
      isFocused={launch.focused && isPaneFocused}
      data-testid="tab-launch-placeholder"
      onClick={() => focusTabLaunch(environmentId, launch.tabId, launchScope)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.currentTarget.click();
        }
      }}
    >
      <span className="text-shimmer">{launch.title}</span>
    </TabShell>
  );
}

/**
 * The whole pane while an environment has no tab yet: setup has not published
 * its terminal, or the job tab has not landed.
 */
export function EnvironmentTabsShimmer({ title }: { title?: string }) {
  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col bg-background"
      data-testid="environment-tabs-shimmer"
    >
      <div className={TAB_STRIP_CLASS} aria-hidden="true">
        <TabShell isActive>
          {title ? (
            <span className="text-shimmer">{title}</span>
          ) : (
            <span className="session-refresh-shimmer block w-16">
              <span className="block h-2 rounded-full bg-muted-foreground/10" />
            </span>
          )}
        </TabShell>
      </div>
      <div className="relative min-h-0 flex-1">
        <TabLaunchShimmer />
      </div>
    </div>
  );
}
