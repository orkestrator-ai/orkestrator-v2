/**
 * "Linear is connected on <machine>": shown on a command node that is not
 * connected while one of its machines is (docs/todo/cross-cutting/7766-
 * linear-boards-per-project-and-coordinator-tools.md, task 2). Use it here
 * asks the command node to copy that machine's key once, over the node link;
 * the key never reaches the window.
 */
import { Loader2, MonitorSmartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { LinearNodeConnection } from "@/types/linear";

export function LinearUseConnectionNotice({
  connections,
  copyingFrom,
  onUse,
}: {
  /** The other machines' connections; only connected ones are offered. */
  connections: readonly LinearNodeConnection[];
  /** The node a copy is running from, if any. */
  copyingFrom: string | null;
  onUse: (nodeId: string) => void;
}) {
  const connected = connections.filter((connection) => connection.connected);
  if (connected.length === 0) return null;
  return (
    <div className="mt-4 space-y-2 text-left">
      {connected.map((connection) => {
        const name = connection.nodeName || "another machine";
        return (
          <div
            key={connection.nodeId}
            className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-background p-3"
          >
            <MonitorSmartphone className="h-4 w-4 shrink-0 text-muted-foreground" />
            <p className="min-w-0 flex-1 text-sm text-foreground">
              Linear is connected on <span className="font-medium">{name}</span>
              {connection.viewerName && (
                <span className="text-muted-foreground"> (as {connection.viewerName})</span>
              )}
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={copyingFrom !== null}
              onClick={() => onUse(connection.nodeId)}
              aria-label={`Use the Linear connection from ${name} here`}
            >
              {copyingFrom === connection.nodeId && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              )}
              Use it here
            </Button>
          </div>
        );
      })}
    </div>
  );
}
