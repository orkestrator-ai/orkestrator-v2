import { useId, useState } from "react";
import { toast } from "sonner";
import type { AutoPipelineSource } from "@orkestrator/protocol/build-pipeline";
import { PipeIcon } from "@/components/icons/PipeIcon";
import { Button } from "@/components/ui/button";
import { useCoordinatedRead } from "@/hooks/useCoordinatedRead";
import { useScopeBackend } from "@/hooks/useScopeBackend";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import { readCoordinatorFor } from "@/lib/read-coordinator";
import type { CreateTabOptions } from "@/contexts/TerminalContext";
import { getAllLeaves, usePaneLayoutStore } from "@/stores";

/**
 * How often the active tab's eligibility is re-read while the window is
 * visible and connected. The read is backend storage and in-memory activity
 * only: it never starts or contacts a bridge (`AutoPipelineService.sources`).
 */
const POLL_MS = 2000;

/** The id of the active tab of the environment's active pane, or null. */
function useActiveTabId(environmentId: string): string | null {
  return usePaneLayoutStore((state) => {
    const environment = state.environments.get(environmentId);
    if (!environment) return null;
    return (
      getAllLeaves(environment.root).find((leaf) => leaf.id === environment.activePaneId)
        ?.activeTabId ?? null
    );
  });
}

/**
 * The source the backend offers for `tabId`, or null while the tab is not an
 * open interactive agent tab of a prompt environment. Reads through the node's
 * read coordinator only while a tab is active, so polling pauses while the
 * window is hidden or the node's connection is down, catches up once when
 * either returns, and stops when unmounted.
 */
function useAutoPipelineSource(environmentId: string, tabId: string | null) {
  const backend = useScopeBackend();
  // This node's own coordinator: its transport is the one whose outage pauses it.
  const coordinator = readCoordinatorFor(useScopesWithCommandFallback().scope);
  // Keyed by tab so a read for the previous tab is never shown for this one.
  const [found, setFound] = useState<{
    tabId: string;
    source: AutoPipelineSource | null;
  } | null>(null);
  useCoordinatedRead({
    key: { resource: "auto-pipeline-sources", target: environmentId, view: tabId ?? "" },
    enabled: tabId !== null,
    retainOnDispose: false,
    coordinator,
    demand: { intervalMs: POLL_MS, priority: "auxiliary" },
    read: () => backend.autoPipelineSources(environmentId),
    onState: (state) => {
      if (!tabId) return;
      if (state.status === "current") {
        const value = state.value;
        setFound({
          tabId,
          source:
            (value?.available && value.sources.find((entry) => entry.tabId === tabId)) || null,
        });
      } else if (state.status === "error" || state.status === "unsupported") {
        setFound({ tabId, source: null });
      }
    },
  });
  return tabId && found?.tabId === tabId ? found.source : null;
}

/**
 * "To pipeline" in the environment toolbar: turns the active agent tab's work
 * into a pipeline. It opens (or focuses) the Auto-pipeline tab for that tab and
 * asks the tab's own agent to draft; the draft appears there for review, and
 * nothing is created until the user confirms. Shown only for a tab the backend
 * offers, so it is absent for terminals, pipeline environments and project homes.
 */
export function ToPipelineButton({
  environmentId,
  createTab,
  showLabel = false,
}: {
  environmentId: string;
  /** The workspace's tab factory; false when the tab could not open (the tab limit). */
  createTab: ((type: "auto-pipeline", options?: CreateTabOptions) => boolean) | null;
  showLabel?: boolean;
}) {
  const backend = useScopeBackend();
  const reasonId = useId();
  const source = useAutoPipelineSource(environmentId, useActiveTabId(environmentId));
  if (!source) return null;
  const reason = source.disabledReason;

  function start(target: AutoPipelineSource) {
    // Drafting starts only once its tab exists to show and cancel it; a tab
    // that could not open (the tab limit) starts nothing.
    if (
      !createTab?.("auto-pipeline", {
        autoPipeline: { sourceTabId: target.tabId, sourceLabel: target.label },
      })
    )
      return;
    // The backend owns drafting and records its outcome; the Auto-pipeline tab
    // reads it, so nothing here waits for it. A refusal is still shown.
    void backend.draftAutoPipeline(environmentId, target.tabId).catch((error: unknown) => {
      toast.error("Auto-pipeline drafting did not start", {
        description: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 touch-manipulation"
        aria-label="To pipeline"
        aria-describedby={reason ? reasonId : undefined}
        title={
          reason ?? "To pipeline: ask this tab's agent to draft a ticket and handoff for review"
        }
        disabled={!createTab || !!reason}
        onClick={() => start(source)}
      >
        <PipeIcon className="size-4" />
        {showLabel && <span className="truncate text-xs">To pipeline</span>}
      </Button>
      {reason && (
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      )}
    </>
  );
}
