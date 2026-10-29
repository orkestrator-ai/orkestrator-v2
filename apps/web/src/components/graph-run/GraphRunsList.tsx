import { useEffect } from "react";
import { FlaskConical, Loader2, RefreshCw, Workflow } from "lucide-react";
import type { GraphRunSummary } from "@orkestrator/protocol/graphs/run-view";
import { Button } from "@/components/ui/button";
import { useOptionalTerminalContext } from "@/contexts/TerminalContext";
import { onResourceChanged, onResourceResync, onViewSafetyCheck } from "@/lib/resource-sync";
import { cn } from "@/lib/utils";
import { EMPTY_GRAPH_RUN_LIST, useGraphRunStore } from "@/stores/graphRunStore";

/**
 * The environment's graph runs, newest first (item 211). A row opens the run
 * in its own `graph-run` tab. The list is a backend snapshot: it is re-read
 * on mount, on any `graph-run` change, on resource resyncs and on view
 * safety checks. Launching runs is item 214's.
 */

const STATUS_WORDS: Record<GraphRunSummary["status"], string> = {
  provisioning: "preparing",
  running: "running",
  waiting: "waiting for you",
  paused: "paused",
  complete: "complete",
  failed: "failed",
  cancelling: "stopping",
  cancelled: "cancelled",
};

const STATUS_TONE: Record<GraphRunSummary["status"], string> = {
  provisioning: "text-cyan-300",
  running: "text-cyan-300",
  waiting: "text-amber-300",
  paused: "text-amber-300",
  complete: "text-green-300",
  failed: "text-failure",
  cancelling: "text-muted-foreground",
  cancelled: "text-muted-foreground",
};

function startedText(summary: GraphRunSummary): string {
  const parsed = Date.parse(summary.createdAt);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : summary.createdAt;
}

export function GraphRunsList({
  environmentId,
  className,
}: {
  environmentId: string;
  className?: string;
}) {
  const list = useGraphRunStore((state) => state.lists.get(environmentId)) ?? EMPTY_GRAPH_RUN_LIST;
  const loadList = useGraphRunStore((state) => state.loadList);
  const createTab = useOptionalTerminalContext()?.createTab;

  useEffect(() => {
    void loadList(environmentId);
    const reload = () => void loadList(environmentId);
    const offChange = onResourceChanged("graph-run", reload);
    const offResync = onResourceResync(reload);
    const offSafety = onViewSafetyCheck(reload);
    return () => {
      offChange();
      offResync();
      offSafety();
    };
  }, [environmentId, loadList]);

  const open = (summary: GraphRunSummary) =>
    createTab?.("graph-run", { graphRun: { runId: summary.id, title: summary.name } });

  return (
    <section aria-label="Graph runs" className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex items-center gap-2 px-3 py-1.5">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Runs
        </h3>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto h-6 w-6"
          aria-label="Refresh runs"
          onClick={() => void loadList(environmentId)}
        >
          {list.status === "loading" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {list.status === "error" ? (
          <p role="alert" className="px-1.5 text-xs text-failure">
            Could not list the runs: {list.error}
          </p>
        ) : list.runs.length === 0 ? (
          <p className="px-1.5 text-xs text-muted-foreground" data-testid="graph-runs-empty">
            {list.status === "ready" ? "No graph runs in this environment yet." : "Loading runs…"}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {list.runs.map((summary) => (
              <li key={summary.id}>
                <button
                  type="button"
                  data-graph-run-row={summary.id}
                  className="flex w-full min-w-0 flex-col gap-0.5 rounded-md px-1.5 py-1 text-left hover:bg-elevated disabled:opacity-60"
                  disabled={!createTab}
                  onClick={() => open(summary)}
                  title={`Open ${summary.name}`}
                >
                  <span className="flex min-w-0 items-center gap-1.5 text-xs">
                    <Workflow aria-hidden className="size-3.5 shrink-0 text-indigo-400" />
                    <span className="min-w-0 truncate font-medium">{summary.name}</span>
                    {summary.mock ? (
                      <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-violet-300">
                        <FlaskConical aria-hidden className="size-3" />
                        mock
                      </span>
                    ) : null}
                    <span
                      className={cn("ml-auto shrink-0 text-[11px]", STATUS_TONE[summary.status])}
                    >
                      {STATUS_WORDS[summary.status]}
                    </span>
                  </span>
                  <span className="truncate pl-5 text-[11px] text-muted-foreground">
                    {startedText(summary)}
                    {summary.activations.awaitingHuman > 0
                      ? ` · ${summary.activations.awaitingHuman} waiting for you`
                      : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
