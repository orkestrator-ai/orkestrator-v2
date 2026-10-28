import { useMemo, useState, type ReactNode } from "react";
import { Download, GitBranch, Maximize2, Radio, Table2 } from "lucide-react";
import {
  layoutWorkflowSnapshot,
  type WorkflowSnapshotV1,
} from "@orkestrator/protocol/workflow-snapshot";
import { artifactFilename, downloadText } from "@/lib/chat/artifact-download";
import { useRichViewField, type RichViewChoice } from "@/stores/richContentViewStore";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { RichBlockFrame, RichToolbarButton } from "./RichBlockFrame";
import {
  WorkflowNodeDetails,
  WorkflowSnapshotGraph,
  WorkflowSnapshotTable,
  WorkflowStatusIcon,
  formatSnapshotTime,
  workflowStatusText,
} from "./WorkflowSnapshotCardGraph";
import { WorkflowLiveInspector } from "./WorkflowLiveInspector";
import { RichPinRecoveryNotice, useRichViewPin } from "./CodeBlockViewer";

/**
 * A historical workflow snapshot, exactly as the backend captured it. The
 * card is labelled "Snapshot" with its capture time and source revision and
 * never changes when the run progresses: live state opens in the separate
 * WorkflowLiveInspector, whose data never flows back into this card.
 *
 * Large graphs show a bounded, explicitly labelled subset inline; the full
 * captured graph opens in a bounded inspector dialog.
 */

/** Inline cards draw at most this many nodes; the full inspector draws all captured nodes. */
export const WORKFLOW_INLINE_NODE_LIMIT = 24;

export interface WorkflowSnapshotCardProps {
  snapshot: WorkflowSnapshotV1;
  viewKey: string;
  /** Environment of the conversation; enables "Open live workflow". */
  environmentId: string | null;
  /** Extra toolbar actions owned by the caller (artifact card actions). */
  extraActions?: ReactNode;
  status?: ReactNode;
  liveInspectorPollMs?: number;
}

function inlineSubset(snapshot: WorkflowSnapshotV1) {
  if (snapshot.nodes.length <= WORKFLOW_INLINE_NODE_LIMIT) {
    return { nodes: snapshot.nodes, edges: snapshot.edges, truncated: false };
  }
  // Deterministic: the first nodes in layout order (role column, then id).
  const layout = layoutWorkflowSnapshot(snapshot);
  const ordered = layout.nodes
    .slice()
    .sort((a, b) => a.column - b.column || a.row - b.row)
    .slice(0, WORKFLOW_INLINE_NODE_LIMIT);
  const keep = new Set(ordered.map((node) => node.id));
  return {
    nodes: snapshot.nodes.filter((node) => keep.has(node.id)),
    edges: snapshot.edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to)),
    truncated: true,
  };
}

export function WorkflowSnapshotCard({
  snapshot,
  viewKey,
  environmentId,
  extraActions,
  status,
  liveInspectorPollMs,
}: WorkflowSnapshotCardProps) {
  const [view, setView] = useRichViewField(viewKey, "view", "preview" as RichViewChoice);
  const [expanded, setExpanded] = useRichViewField(viewKey, "expanded", false);
  const [liveOpen, setLiveOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const subset = useMemo(() => inlineSubset(snapshot), [snapshot]);
  const selected = snapshot.nodes.find((node) => node.id === selectedId) ?? null;
  const title = snapshot.title || "Workflow";
  const captured = formatSnapshotTime(snapshot.capturedAt);
  const { completeness } = snapshot;

  const pin = useRichViewPin(viewKey, expanded, () => setExpanded(false));

  const actions = (
    <>
      {extraActions}
      <RichToolbarButton
        label="Graph view"
        pressed={view !== "data"}
        onClick={() => setView("preview")}
      >
        <GitBranch aria-hidden="true" />
      </RichToolbarButton>
      <RichToolbarButton
        label="Table view"
        pressed={view === "data"}
        onClick={() => setView("data")}
      >
        <Table2 aria-hidden="true" />
      </RichToolbarButton>
      <RichToolbarButton
        label="Open full inspector"
        pressed={expanded}
        onClick={() => setExpanded(true)}
      >
        <Maximize2 aria-hidden="true" />
      </RichToolbarButton>
      <RichToolbarButton
        label="Download snapshot JSON"
        onClick={() =>
          downloadText(
            `${JSON.stringify(snapshot, null, 2)}\n`,
            artifactFilename(`${title} snapshot`, "json"),
            "application/json",
          )
        }
      >
        <Download aria-hidden="true" />
      </RichToolbarButton>
    </>
  );

  const omission =
    completeness.mode === "summary" ? (
      <p
        role="note"
        data-workflow-omission="true"
        className="mb-2 rounded border border-amber-400/40 bg-amber-500/10 px-2 py-1 text-[11px]"
      >
        Summary snapshot: {snapshot.nodes.length} of {completeness.totalNodes} nodes and{" "}
        {snapshot.edges.length} of {completeness.totalEdges} edges were captured (
        {completeness.omittedNodes} nodes and {completeness.omittedEdges} edges omitted
        {completeness.reason === "size-limit" ? " by the size limit" : ""}). Open the live workflow
        for the full run.
      </p>
    ) : null;

  return (
    <>
      <RichBlockFrame
        kind="workflow-snapshot"
        blockKey={viewKey}
        title={
          <span className="flex items-center gap-1.5">
            <span className="rounded bg-elevated px-1 py-px text-[10px] font-semibold tracking-wide uppercase">
              Snapshot
            </span>
            <span className="truncate">{title}</span>
          </span>
        }
        ariaLabel={`Workflow snapshot: ${title}`}
        subtitle={`Captured ${captured} · revision ${snapshot.sourceRevision}`}
        status={status}
        actions={actions}
      >
        {pin.displaced ? (
          <RichPinRecoveryNotice
            what="full inspector"
            onReopen={pin.reopen}
            onDismiss={pin.dismiss}
          />
        ) : null}
        <div className="px-3 pb-3 pt-2 text-xs">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span
              className="inline-flex items-center gap-1"
              data-workflow-run-status={snapshot.status}
            >
              <WorkflowStatusIcon status={snapshot.status} />
              Run status at capture: {workflowStatusText(snapshot.status)}
            </span>
            {environmentId ? (
              <button
                type="button"
                onClick={() => setLiveOpen(true)}
                className="ml-auto inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 outline-none hover:bg-elevated focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <Radio aria-hidden="true" className="size-3" /> Open live workflow
              </button>
            ) : (
              <span className="ml-auto text-muted-foreground">
                Live view unavailable outside its conversation
              </span>
            )}
          </div>
          {snapshot.description ? (
            <p className="mb-2 text-foreground/90">{snapshot.description}</p>
          ) : null}
          {omission}
          {view === "data" ? (
            <WorkflowSnapshotTable nodes={snapshot.nodes} caption={`Nodes captured ${captured}`} />
          ) : (
            <>
              {subset.truncated ? (
                <p className="mb-1 text-[11px] text-muted-foreground" data-workflow-subset="true">
                  Readable subset: showing {subset.nodes.length} of {snapshot.nodes.length} captured
                  nodes.{" "}
                  <button type="button" className="underline" onClick={() => setExpanded(true)}>
                    Open full inspector
                  </button>
                </p>
              ) : null}
              <WorkflowSnapshotGraph
                nodes={subset.nodes}
                edges={subset.edges}
                selectedId={selectedId}
                onSelect={setSelectedId}
                label={`Workflow graph for ${title}, captured ${captured}`}
              />
            </>
          )}
          {selected ? <WorkflowNodeDetails node={selected} workflowTitle={title} /> : null}
        </div>
      </RichBlockFrame>
      {expanded ? (
        <Dialog open onOpenChange={setExpanded}>
          <DialogContent size="5xl">
            <DialogTitle>Snapshot · {title}</DialogTitle>
            <DialogDescription>
              Captured {captured} · revision {snapshot.sourceRevision}. Historical data; it does not
              update.
            </DialogDescription>
            {omission}
            <WorkflowSnapshotGraph
              nodes={snapshot.nodes}
              edges={snapshot.edges}
              selectedId={selectedId}
              onSelect={setSelectedId}
              label={`Full workflow graph for ${title}`}
            />
            {selected ? <WorkflowNodeDetails node={selected} workflowTitle={title} /> : null}
            <WorkflowSnapshotTable
              nodes={snapshot.nodes}
              caption={`All captured nodes of ${title}`}
            />
          </DialogContent>
        </Dialog>
      ) : null}
      {environmentId && liveOpen ? (
        <WorkflowLiveInspector
          open
          onOpenChange={setLiveOpen}
          environmentId={environmentId}
          workflowId={snapshot.workflowId}
          runId={snapshot.runId}
          title={title}
          historical={{ capturedAt: snapshot.capturedAt, sourceRevision: snapshot.sourceRevision }}
          pollIntervalMs={liveInspectorPollMs}
        />
      ) : null}
    </>
  );
}
