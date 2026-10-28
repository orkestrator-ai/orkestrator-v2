import { useCallback, useEffect, useRef, useState, useLayoutEffect } from "react";
import { Radio, RefreshCw } from "lucide-react";
import {
  validateWorkflowSnapshot,
  type WorkflowSnapshotV1,
} from "@orkestrator/protocol/workflow-snapshot";
import { getWorkflowLiveSnapshot } from "@/lib/backend/transcript-artifacts";
import { onResourceChanged, onResourceResync } from "@/lib/resource-sync";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  WorkflowNodeDetails,
  WorkflowSnapshotGraph,
  WorkflowSnapshotTable,
  formatSnapshotTime,
  workflowStatusText,
} from "./WorkflowSnapshotCardGraph";

/**
 * The live workflow inspector: a separate view of the run's *current* state,
 * read from the backend's existing workflow services. It never writes into
 * the historical snapshot card; closing it stops only this viewer's polling.
 *
 * Authoritative snapshots are polled and also refetched on resource change
 * events and resync requests (reconnect, revision gaps). A response from an
 * older request never replaces a newer one.
 */

export type WorkflowLivePhase = "connecting" | "live" | "stale" | "terminal" | "unavailable";

export interface WorkflowLiveState {
  phase: WorkflowLivePhase;
  snapshot: WorkflowSnapshotV1 | null;
  lastUpdatedAt: number | null;
  message: string | null;
  changedIds: ReadonlySet<string>;
}

const WORKFLOW_RESOURCE_KINDS = ["multi-review", "looped-review", "build-pipeline"] as const;
const DEFAULT_POLL_MS = 4_000;
const MAX_BACKOFF_MS = 30_000;
const STALE_AFTER_FAILURES = 2;
const NO_CHANGES: ReadonlySet<string> = new Set();

function changedNodeIds(
  previous: WorkflowSnapshotV1 | null,
  next: WorkflowSnapshotV1,
): ReadonlySet<string> {
  if (!previous) return NO_CHANGES;
  const before = new Map(previous.nodes.map((node) => [node.id, node.status]));
  const changed = new Set<string>();
  for (const node of next.nodes) {
    const status = before.get(node.id);
    if (status !== undefined && status !== node.status) changed.add(node.id);
  }
  return changed;
}

export function useWorkflowLiveSnapshot({
  environmentId,
  workflowId,
  runId,
  enabled,
  pollIntervalMs = DEFAULT_POLL_MS,
}: {
  environmentId: string;
  workflowId: string;
  runId: string;
  enabled: boolean;
  pollIntervalMs?: number;
}): WorkflowLiveState & { refresh: () => void } {
  const [state, setState] = useState<WorkflowLiveState>({
    phase: "connecting",
    snapshot: null,
    lastUpdatedAt: null,
    message: null,
    changedIds: NO_CHANGES,
  });
  const requestSeq = useRef(0);
  const appliedSeq = useRef(0);
  const failures = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposed = useRef(false);
  const fetchRef = useRef<() => void>(() => {});

  const schedule = useCallback((delay: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => fetchRef.current(), delay);
  }, []);

  const fetchNow = useCallback(() => {
    if (disposed.current) return;
    const seq = ++requestSeq.current;
    getWorkflowLiveSnapshot({ environmentId, workflowId, runId })
      .then((response) => {
        if (disposed.current || seq < appliedSeq.current) return;
        appliedSeq.current = seq;
        if (response.status === "unavailable") {
          failures.current = 0;
          setState((previous) => ({
            ...previous,
            phase: "unavailable",
            message:
              response.reason === "deleted" || response.reason === "not_found"
                ? "This run no longer exists. The saved snapshot in the transcript is unchanged."
                : "Live data for this workflow is unavailable.",
          }));
          return;
        }
        const checked = validateWorkflowSnapshot(response.snapshot);
        if (
          !checked.ok ||
          checked.value.workflowId !== workflowId ||
          checked.value.runId !== runId
        ) {
          throw new Error("invalid live snapshot");
        }
        failures.current = 0;
        setState((previous) => ({
          phase: response.terminal ? "terminal" : "live",
          snapshot: checked.value,
          lastUpdatedAt: Date.now(),
          message: null,
          changedIds: changedNodeIds(previous.snapshot, checked.value),
        }));
        if (!response.terminal) schedule(pollIntervalMs);
      })
      .catch(() => {
        if (disposed.current || seq < appliedSeq.current) return;
        appliedSeq.current = seq;
        failures.current += 1;
        if (failures.current >= STALE_AFTER_FAILURES) {
          setState((previous) => ({
            ...previous,
            phase: "stale",
            message: previous.snapshot
              ? "Offline — showing the last live update. Retrying…"
              : "Cannot reach the workflow service. Retrying…",
          }));
        }
        schedule(Math.min(MAX_BACKOFF_MS, pollIntervalMs * 2 ** failures.current));
      });
  }, [environmentId, pollIntervalMs, runId, schedule, workflowId]);
  useLayoutEffect(() => {
    fetchRef.current = fetchNow;
  });

  useEffect(() => {
    if (!enabled) return;
    disposed.current = false;
    fetchNow();
    const unsubscribes = WORKFLOW_RESOURCE_KINDS.map((kind) =>
      onResourceChanged(kind, (change) => {
        if (change.id === workflowId) fetchRef.current();
      }),
    );
    unsubscribes.push(onResourceResync(() => fetchRef.current()));
    return () => {
      disposed.current = true;
      if (timer.current) clearTimeout(timer.current);
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [enabled, fetchNow, workflowId]);

  return { ...state, refresh: fetchNow };
}

const PHASE_LABEL: Record<WorkflowLivePhase, string> = {
  connecting: "Connecting…",
  live: "Live",
  stale: "Stale / offline",
  terminal: "Finished (no further updates)",
  unavailable: "Live data unavailable",
};

export function WorkflowLiveInspector({
  open,
  onOpenChange,
  environmentId,
  workflowId,
  runId,
  title,
  historical,
  pollIntervalMs,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: string;
  workflowId: string;
  runId: string;
  title: string;
  historical: { capturedAt: string; sourceRevision: string };
  pollIntervalMs?: number;
}) {
  const live = useWorkflowLiveSnapshot({
    environmentId,
    workflowId,
    runId,
    enabled: open,
    pollIntervalMs,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);
  const selected = live.snapshot?.nodes.find((node) => node.id === selectedId) ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="5xl" data-workflow-live-inspector="true">
        <DialogTitle className="flex items-center gap-2">
          <Radio aria-hidden="true" className="size-4" />
          Live workflow · {title}
        </DialogTitle>
        <DialogDescription>
          Current state from the workflow service. The transcript snapshot captured{" "}
          {formatSnapshotTime(historical.capturedAt)} (revision {historical.sourceRevision}) is not
          changed by this view.
        </DialogDescription>
        <div className="flex flex-wrap items-center gap-2 text-xs" role="status" aria-live="polite">
          <span
            data-workflow-live-phase={live.phase}
            className="rounded border border-border px-1.5 py-0.5 font-medium"
          >
            {PHASE_LABEL[live.phase]}
          </span>
          {live.snapshot ? (
            <span className="text-muted-foreground">
              Run status {workflowStatusText(live.snapshot.status)} · revision{" "}
              {live.snapshot.sourceRevision}
              {live.lastUpdatedAt
                ? ` · updated ${new Date(live.lastUpdatedAt).toLocaleTimeString()}`
                : ""}
            </span>
          ) : null}
          {live.message ? <span className="text-muted-foreground">{live.message}</span> : null}
          <button
            type="button"
            onClick={live.refresh}
            className="ml-auto inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 outline-none hover:bg-elevated focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <RefreshCw aria-hidden="true" className="size-3" /> Refresh
          </button>
          <button
            type="button"
            aria-pressed={showTable}
            onClick={() => setShowTable((value) => !value)}
            className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 outline-none hover:bg-elevated focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            Table view
          </button>
        </div>
        {live.snapshot ? (
          <div>
            {live.snapshot.completeness.mode === "summary" ? (
              <p className="mb-1 text-[11px] text-amber-300" role="note">
                The workflow service returned a summary: {live.snapshot.nodes.length} of{" "}
                {live.snapshot.completeness.totalNodes} nodes.
              </p>
            ) : null}
            {showTable ? (
              <WorkflowSnapshotTable
                nodes={live.snapshot.nodes}
                caption={`Live nodes of ${title}`}
              />
            ) : (
              <WorkflowSnapshotGraph
                nodes={live.snapshot.nodes}
                edges={live.snapshot.edges}
                selectedId={selectedId}
                onSelect={setSelectedId}
                changedIds={live.changedIds}
                label={`Live workflow graph for ${title}`}
              />
            )}
            {selected ? <WorkflowNodeDetails node={selected} workflowTitle={title} /> : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
