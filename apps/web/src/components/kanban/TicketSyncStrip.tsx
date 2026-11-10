import { incompatibility } from "@orkestrator/protocol/contract/errors";
import { useEffect, useState } from "react";
import { AlertTriangle, Share2 } from "lucide-react";
import {
  TICKET_SYNC_STATUS_EVENT,
  type TicketSyncConflict,
  type TicketSyncLeafStatus,
  type TicketSyncNodeState,
  type TicketSyncStatusResult,
} from "@orkestrator/protocol/ticket-sync";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT, listen } from "@/lib/native/events";
import { cn } from "@/lib/utils";
import { useScopeBackend } from "@/hooks/useScopeBackend";

/**
 * The board's one line about other machines (docs/architecture/tickets.md,
 * "Sync across machines"). On a command node: which machines with a copy of
 * this project hold the board's tickets, which are offline or behind, which
 * need an update, and the leaf changes that lost a conflict, listed in a
 * dialog where each opens its ticket or is dismissed. On a leaf: the command
 * node its copies come from, and Share for tickets made before sync began;
 * or, on a second copy of a repository, which copy syncs instead. Nothing on
 * a board no other machine shares.
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

/**
 * This board's view as a leaf: the command nodes its copies come from. `null`
 * on a board no command node syncs, and on a backend that predates the read.
 */
export function useTicketSyncLeafStatus(
  projectId: string,
  boardRevision: unknown,
): TicketSyncLeafStatus | null {
  const nodeBackend = useScopeBackend();
  const [status, setStatus] = useState<TicketSyncLeafStatus | null>(null);
  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      void (async () => {
        try {
          const next = await nodeBackend.getTicketSyncLeafStatus(projectId);
          if (!disposed && next && Array.isArray(next.controllers)) setStatus(next);
        } catch {
          // An older backend, or a passing failure: keep what is shown.
        }
      })();
    };
    const unlisteners: Array<() => void> = [];
    void listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, () => refresh())
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
      })
      .catch(() => undefined);
    const timer = setInterval(refresh, 30_000);
    refresh();
    return () => {
      disposed = true;
      clearInterval(timer);
      for (const unlisten of unlisteners) unlisten();
    };
  }, [projectId, boardRevision, nodeBackend]);
  if (status?.projectId !== projectId) return null;
  return status.controllers.length || status.syncedCopy ? status : null;
}

function nodeTitle(node: TicketSyncNodeState): string {
  const parts = [node.message ?? `${node.nodeName} has every ticket on this board.`];
  if (node.projectName) parts.push(`It syncs with its project ${node.projectName}.`);
  if (node.otherCopies) {
    parts.push(
      node.otherCopies === 1
        ? "Its other copy of this repository keeps its own board."
        : `Its ${node.otherCopies} other copies of this repository keep their own boards.`,
    );
  }
  return parts.join(" ");
}

function conflictSummary(conflict: TicketSyncConflict): string {
  const who = conflict.fromNodeName ?? conflict.fromNodeId;
  if (conflict.reason === "ticket-deleted") {
    return `${who} changed it after it was deleted here; the change was not applied.`;
  }
  const field = conflict.field === "content" ? "description" : conflict.field;
  return `${who} changed the ${field} while it also changed here; this board's version was kept.`;
}

function formatWhen(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString();
}

export interface TicketSyncStripProps {
  status: BoardTicketSyncStatus | null;
  /** This board as a leaf (`useTicketSyncLeafStatus`). */
  leafStatus?: TicketSyncLeafStatus | null;
  /** Ticket titles on this board, for the conflict list. */
  ticketTitles?: ReadonlyMap<string, string>;
  onOpenTicket?: (ticketId: string) => void;
  /** Dismiss these conflicts, or every one when `ids` is absent. */
  onDismissConflicts?: (ids?: string[]) => Promise<void>;
  /** Share every ticket made here before sync began with the command node. */
  onShareAll?: () => Promise<void>;
}

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

export function TicketSyncStrip({
  status,
  leafStatus,
  ticketTitles,
  onOpenTicket,
  onDismissConflicts,
  onShareAll,
}: TicketSyncStripProps) {
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const shares = Boolean(status && (status.nodes.length > 0 || status.error));
  if (!shares && !leafStatus) return null;
  const conflicts = status?.conflicts ?? [];
  const conflictCount = status?.conflictCount ?? conflicts.length;
  const latest = conflicts.at(-1);
  const run = (work: () => Promise<void>) => {
    setBusy(true);
    void work()
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  const controller = leafStatus?.controllers[0];
  return (
    <div
      data-testid="ticket-sync-strip"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-3 text-xs text-muted-foreground sm:px-6"
    >
      {status?.error && (
        <span role="status" className="text-amber-500">
          {status.error}
        </span>
      )}
      {leafStatus && controller && (
        <span data-testid="ticket-sync-leaf" className="inline-flex flex-wrap items-center gap-x-2">
          <span>
            Tickets synced from{" "}
            <span className="font-medium text-foreground">
              {leafStatus.controllers.map((entry) => entry.nodeName).join(", ")}
            </span>
          </span>
          {controller.pending > 0 && (
            <span title="Changes made here wait until the command node collects them.">
              · {controller.pending} change{controller.pending === 1 ? "" : "s"} waiting
            </span>
          )}
          {leafStatus.unshared > 0 && onShareAll && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              className="h-6 gap-1 px-2 text-xs"
              title={`Tickets made on this board before it synced with ${controller.nodeName} stay here until you share them.`}
              onClick={() => run(onShareAll)}
            >
              <Share2 className="h-3 w-3" />
              Share {leafStatus.unshared} older ticket{leafStatus.unshared === 1 ? "" : "s"} with{" "}
              {controller.nodeName}
            </Button>
          )}
        </span>
      )}
      {leafStatus?.syncedCopy && !controller && (
        <span data-testid="ticket-sync-other-copy">
          This board is not synced: {leafStatus.syncedCopy.projectName} is this machine&apos;s copy
          of the repository that syncs with {leafStatus.syncedCopy.nodeName}.
        </span>
      )}
      {status && status.nodes.length > 0 && <span>Tickets shared with</span>}
      {status?.nodes.map((node) => {
        const label = STATE_LABELS[node.state];
        return (
          <span
            key={node.nodeId}
            data-testid="ticket-sync-node"
            data-state={node.state}
            className="inline-flex items-center gap-1.5"
            title={nodeTitle(node)}
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
        <button
          type="button"
          data-testid="ticket-sync-conflicts"
          className="inline-flex items-center gap-1 rounded text-amber-500 underline-offset-2 hover:underline focus-hairline focus-hairline-outset"
          title={`Latest: ${conflictSummary(latest)} Open the list to review or dismiss them.`}
          onClick={() => setConflictsOpen(true)}
        >
          <AlertTriangle className="h-3 w-3" />
          {conflictCount} sync conflict{conflictCount === 1 ? "" : "s"}
        </button>
      )}
      <Dialog open={conflictsOpen && conflicts.length > 0} onOpenChange={setConflictsOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>Sync conflicts</DialogTitle>
            <DialogDescription>
              Changes from other machines that this board did not apply. Each ticket also has a
              comment with the other version. Dismissing removes a conflict from this list only.
            </DialogDescription>
          </DialogHeader>
          <ul
            data-testid="ticket-sync-conflict-list"
            className="max-h-[60vh] space-y-2 overflow-y-auto"
          >
            {[...conflicts].reverse().map((conflict, index) => (
              <li
                key={conflict.id ?? `${conflict.at}-${index}`}
                data-testid="ticket-sync-conflict"
                className="rounded-md border border-border p-2 text-sm"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-foreground">
                      {ticketTitles?.get(conflict.ticketId) ?? "A deleted ticket"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatWhen(conflict.at)} · {conflictSummary(conflict)}
                    </div>
                    {conflict.value && conflict.reason === "stale-revision" && (
                      <div className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">
                        Their version: {conflict.value}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {onOpenTicket && ticketTitles?.has(conflict.ticketId) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => {
                          setConflictsOpen(false);
                          onOpenTicket(conflict.ticketId);
                        }}
                      >
                        Open
                      </Button>
                    )}
                    {onDismissConflicts && conflict.id && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        className="h-7 px-2 text-xs"
                        onClick={() => run(() => onDismissConflicts([conflict.id!]))}
                      >
                        Dismiss
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {conflictCount > conflicts.length && (
            <p className="text-xs text-muted-foreground">
              Showing the latest {conflicts.length} of {conflictCount}.
            </p>
          )}
          {onDismissConflicts && (
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => run(() => onDismissConflicts())}
              >
                Dismiss all
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
