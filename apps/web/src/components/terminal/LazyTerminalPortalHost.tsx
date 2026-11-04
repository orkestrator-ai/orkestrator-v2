import { loadTerminalPortalHost } from "@/lib/lazy-view-loaders";
import { lazy, memo, useState } from "react";
import { LazyLoadBoundary, LazyLoadInlineErrorFallback } from "@/components/LazyLoadBoundary";
import { getAllLeaves, usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { isTerminalTab } from "./terminal-tab-types";

const LoadedTerminalPortalHost = lazy(loadTerminalPortalHost);

/**
 * Loads `TerminalPortalHost`, and xterm.js with it, the first time this
 * environment has a terminal tab, so an environment with only agent tabs never
 * pays for it.
 *
 * The host then stays mounted when the last terminal tab goes away: it is what
 * disposes the terminals of removed tabs.
 */
export const LazyTerminalPortalHost = memo(function LazyTerminalPortalHost({
  containerId,
  environmentId,
}: {
  containerId: string | null;
  environmentId: string;
}) {
  const hasTerminalTab = usePaneLayoutStore((state) => {
    const root = state.environments.get(environmentId)?.root;
    return root ? getAllLeaves(root).some((leaf) => leaf.tabs.some(isTerminalTab)) : false;
  });
  const [needed, setNeeded] = useState(hasTerminalTab);
  if (hasTerminalTab && !needed) setNeeded(true);
  if (!needed) return null;
  return (
    <LazyLoadBoundary renderError={(details) => <LazyLoadInlineErrorFallback {...details} />}>
      <LoadedTerminalPortalHost containerId={containerId} environmentId={environmentId} />
    </LazyLoadBoundary>
  );
});
