import { incompatibility } from "@orkestrator/protocol/contract/errors";
import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import {
  TICKET_SYNC_STATUS_EVENT,
  type TicketSyncNodeState,
  type TicketSyncStatusResult,
} from "@orkestrator/protocol/ticket-sync";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT, listen } from "@/lib/native/events";
import { cn } from "@/lib/utils";
import { useScopeBackend } from "@/hooks/useScopeBackend";

/**
 * The board's one line about other machines (docs/architecture/tickets.md,
 * "Sync across machines"): which machines with a copy of this project hold
 * the board's tickets, which are offline or behind, which need an update, and
 * how many leaf changes lost a conflict. Nothing on a board no machine shares.
 */

const STATE_LABELS: Record<TicketSyncNodeState["state"], string | null> = {
  "in-sync": null,
  syncing: "syncing",
  behind: "behind",
  offline: "offline",
  "update-required": "update needed",
  error: "sync failed",
};

const STATE_DOTS: Record<TicketSyncNodeState["state"], string> = {
  "in-sync": "bg-green-500",
  syncing: "bg-blue-500 animate-pulse",
  behind: "bg-amber-500",
  offline: "bg-zinc-500",
  "update-required": "bg-amber-500",
  error: "bg-red-500",
};

export type BoardTicketSyncStatus = TicketSyncStatusResult & { error?: string };

/** The project's sync status, re-read on its event, a reconnect, a board change and every 30 s. */
export function useTicketSyncStatus(
  projectId: string,
  boardRevision: unknown,
): BoardTicketSyncStatus | null {
  const nodeBackend = useScopeBackend();
  const [status, setStatus] = useState<BoardTicketSyncStatus | null>(null);
  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      void (async () => {
        try {
          const next = await nodeBackend.getTicketSyncStatus(projectId);
          if (!disposed && next && Array.isArray(next.nodes)) setStatus(next);
        } catch (error) {
          if (disposed) return;
          if (incompatibility(error, "get_ticket_sync_status")?.code === "unknown-command")
            setStatus(null);
          else
            setStatus((previous) => ({
              ...(previous?.projectId === projectId
                ? previous
                : { projectId, nodes: [], conflicts: [] }),
              error: "Ticket sync status is unavailable. Retrying…",
            }));
        }
      })();
    };
    const unlisteners: Array<() => void> = [];
    for (const event of [TICKET_SYNC_STATUS_EVENT, NATIVE_EVENT_STREAM_CONNECTED_EVENT]) {
      void listen(event, () => refresh())
        .then((unlisten) => {
          if (disposed) unlisten();
          else unlisteners.push(unlisten);
        })
        .catch(() => undefined);
    }
    const timer = setInterval(refresh, 30_000);
    refresh();
    return () => {
      disposed = true;
      clearInterval(timer);
      for (const unlisten of unlisteners) unlisten();
    };
  }, [projectId, boardRevision, nodeBackend]);
  return status?.projectId === projectId ? status : null;
}

export function TicketSyncStrip({ status }: { status: BoardTicketSyncStatus | null }) {
  if (!status || (status.nodes.length === 0 && !status.error)) return null;
  const conflicts = status.conflicts;
  const latest = conflicts.at(-1);
  return (
    <div
      data-testid="ticket-sync-strip"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-3 text-xs text-muted-foreground sm:px-6"
    >
      {status.error && (
        <span role="status" className="text-amber-500">
          {status.error}
        </span>
      )}
      {status.nodes.length > 0 && <span>Tickets shared with</span>}
      {status.nodes.map((node) => {
        const label = STATE_LABELS[node.state];
        return (
          <span
            key={node.nodeId}
            data-testid="ticket-sync-node"
            data-state={node.state}
            className="inline-flex items-center gap-1.5"
            title={node.message ?? `${node.nodeName} has every ticket on this board.`}
          >
            <span
              aria-hidden="true"
              className={cn("h-2 w-2 rounded-full", STATE_DOTS[node.state])}
            />
            <span className="font-medium text-foreground">{node.nodeName}</span>
            {label && <span>· {label}</span>}
          </span>
        );
      })}
      {latest && (
        <span
          data-testid="ticket-sync-conflicts"
          className="inline-flex items-center gap-1 text-amber-500"
          title={
            latest.reason === "ticket-deleted"
              ? `Latest: ${latest.fromNodeName ?? latest.fromNodeId} changed a ticket after it was deleted here, so the change was not applied.`
              : `Latest: ${latest.fromNodeName ?? latest.fromNodeId} changed the ${latest.field === "content" ? "description" : latest.field} of a ticket that had also changed here. This board's version was kept; the other is in the ticket's comments.`
          }
        >
          <AlertTriangle className="h-3 w-3" />
          {conflicts.length} sync conflict{conflicts.length === 1 ? "" : "s"}
        </span>
      )}
    </div>
  );
}
