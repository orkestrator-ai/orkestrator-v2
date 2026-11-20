import { useState } from "react";
import type { WorkflowActionsSpec } from "@orkestrator/protocol/rich-interactions";
import { cn } from "@/lib/utils";
import { ActionBar, RefChip, textareaClass, type KindProps } from "../shared";

interface WorkflowDraft {
  nodeId?: string;
  note?: string;
}

const STATE_TONE: Record<string, string> = {
  failed: "text-failure",
  succeeded: "text-success",
  running: "text-primary",
  waiting: "text-amber-300",
};

/**
 * Feature 18: contextual workflow controls. The card is the snapshot the agent
 * reported; retry and stop are registered product commands that recheck the
 * live run (revision, attempt) on the backend before acting, so a historical
 * card can never act on a newer attempt. Unavailable controls explain why.
 */
export function WorkflowActionsCard({
  spec,
  draft,
  setDraft,
  act,
  disabled,
  actions,
}: KindProps<WorkflowActionsSpec>) {
  const confirmationKey = JSON.stringify([spec.runId, spec.snapshotRevision]);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const confirmWholeRun = confirmed === confirmationKey;
  const value = (draft as WorkflowDraft | undefined) ?? {};
  const node = spec.nodes.find((n) => n.id === value.nodeId);
  const eligible = (actionId: string) =>
    actionId === "retry-node"
      ? node?.attemptId && (node.state === "failed" || node.state === "cancelled")
      : actionId === "stop-node"
        ? node?.attemptId && confirmWholeRun
        : Boolean(node);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        {spec.title} · workflow {spec.workflowId} · run {spec.runId} · snapshot revision{" "}
        {spec.snapshotRevision}
      </p>
      <ul className="flex flex-col gap-1" role="listbox" aria-label="Workflow nodes">
        {spec.nodes.map((n) => (
          <li key={n.id}>
            <button
              type="button"
              role="option"
              aria-selected={value.nodeId === n.id}
              className={cn(
                "flex w-full items-center gap-2 rounded border px-2 py-1 text-left text-xs focus-hairline",
                value.nodeId === n.id
                  ? "border-primary/50 bg-primary/10"
                  : "border-border/60 hover:bg-white/[0.03]",
              )}
              onClick={() => setDraft({ ...value, nodeId: n.id })}
            >
              <span className={cn("w-20 shrink-0", STATE_TONE[n.state] ?? "text-muted-foreground")}>
                {n.state}
              </span>
              <span className="font-medium">{n.label}</span>
              {n.attemptId ? (
                <span className="text-muted-foreground">attempt {n.attemptId}</span>
              ) : null}
              {n.owner ? <span className="ml-auto text-muted-foreground">{n.owner}</span> : null}
            </button>
          </li>
        ))}
      </ul>
      {node ? (
        <div className="rounded border border-border/60 p-2 text-xs">
          <p className="font-medium">
            {node.label} · {node.state}
            {node.attemptId ? ` · attempt ${node.attemptId}` : ""}
          </p>
          {node.detail ? (
            <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{node.detail}</p>
          ) : null}
          {node.evidence.length ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {node.evidence.map((r, i) => (
                <RefChip key={i} reference={r} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {!disabled ? (
        <>
          <textarea
            className={textareaClass}
            rows={2}
            aria-label="Note"
            placeholder="Note (optional)"
            value={value.note ?? ""}
            onChange={(e) => setDraft({ ...value, note: e.target.value })}
          />
          {node?.attemptId && actions.some((a) => a.id === "stop-node" && a.available) ? (
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={confirmWholeRun}
                onChange={(event) => setConfirmed(event.target.checked ? confirmationKey : null)}
              />
              Confirm stopping the entire workflow run, including all active stages
            </label>
          ) : null}
          {actions.map((a) => (
            <ActionBar
              key={a.id}
              actions={a.id === "stop-node" ? [{ ...a, label: "Stop workflow run" }] : [a]}
              only={[a.id]}
              disabled={disabled}
              primaryDisabledReason={
                !node
                  ? a.id === actions[0]?.id
                    ? "Select a node."
                    : null
                  : eligible(a.id)
                    ? null
                    : a.id === "stop-node"
                      ? "Confirm the whole-run stop to continue."
                      : `${a.label} is not available for a ${node.state} node.`
              }
              onAction={(x) =>
                node &&
                act(x.id, {
                  nodeId: node.id,
                  snapshotRevision: spec.snapshotRevision,
                  ...(x.id === "stop-node" && confirmWholeRun ? { confirmWholeRun: true } : {}),
                  ...(node.attemptId ? { attemptId: node.attemptId } : {}),
                  ...(value.note?.trim() ? { note: value.note.trim() } : {}),
                })
              }
            />
          ))}
        </>
      ) : null}
    </div>
  );
}
