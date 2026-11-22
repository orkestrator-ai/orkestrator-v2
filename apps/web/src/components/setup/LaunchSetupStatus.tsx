import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useNodeScope } from "@/lib/node-scope/providers";
import { forceResolveSetupRuntime } from "@/lib/setup-commands";
import {
  getAllLeaves,
  paneLayoutStore,
  usePaneLayoutStore,
  type PaneLayoutState,
} from "@/stores/paneLayoutStore";
import type { Environment } from "@/types";

/** What an opening prompt is waiting on while its environment gets ready. */
export function launchSetupStatusText(setupPhase: Environment["setupPhase"] | undefined): string {
  return setupPhase === "running" ? "Running environment setup script…" : "Preparing environment…";
}

function findSetupTab(
  state: PaneLayoutState,
  environmentId: string,
): { paneId: string; tabId: string } | undefined {
  const environment = state.environments.get(environmentId);
  if (!environment) return undefined;
  for (const leaf of getAllLeaves(environment.root)) {
    const tab = leaf.tabs.find((candidate) => candidate.isSetupTab === true);
    if (tab) return { paneId: leaf.id, tabId: tab.id };
  }
  return undefined;
}

const linkClassName =
  "rounded-sm text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline focus-hairline focus-hairline-outset disabled:pointer-events-none disabled:opacity-50";

/**
 * Setup progress for an agent tab whose opening prompt is already on screen.
 *
 * Drawn in the transcript's status row, where "is thinking" will appear once
 * the agent starts, so the conversation reads as started from the moment the
 * environment is created and nothing is swapped out when setup finishes. The
 * setup terminal is one click away rather than in front.
 */
export function LaunchSetupStatus({
  environmentId,
  setupPhase,
}: {
  environmentId: string;
  setupPhase: Environment["setupPhase"] | undefined;
}) {
  const scope = useNodeScope();
  // Two primitive selections, so an unrelated layout change re-renders nothing.
  const setupTabPaneId = usePaneLayoutStore((state) => findSetupTab(state, environmentId)?.paneId);
  const setupTabId = usePaneLayoutStore((state) => findSetupTab(state, environmentId)?.tabId);
  const [confirming, setConfirming] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const skip = async () => {
    setError(null);
    setSkipping(true);
    try {
      await forceResolveSetupRuntime(environmentId, scope);
      setConfirming(false);
    } catch (skipError) {
      setError(skipError instanceof Error ? skipError.message : "Failed to skip setup");
    } finally {
      setSkipping(false);
    }
  };

  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span role="status" className="agent-thinking-shimmer text-xs">
        {launchSetupStatusText(setupPhase)}
      </span>
      {setupTabPaneId && setupTabId ? (
        <button
          type="button"
          className={linkClassName}
          onClick={() =>
            scope
              .store(paneLayoutStore)
              .getState()
              .setActiveTab(setupTabPaneId, setupTabId, environmentId)
          }
        >
          View setup log
        </button>
      ) : null}
      {confirming ? (
        <span className="inline-flex flex-wrap items-center gap-2 text-xs">
          <span>Skipping may start the agent before setup finishes.</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={skipping}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={skipping}
            onClick={() => void skip()}
          >
            {skipping ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            {skipping ? "Skipping setup…" : "Skip anyway"}
          </Button>
        </span>
      ) : (
        <button type="button" className={cn(linkClassName)} onClick={() => setConfirming(true)}>
          Skip setup wait
        </button>
      )}
      {error ? (
        <span role="alert" className="text-xs text-failure">
          {error}
        </span>
      ) : null}
    </span>
  );
}
