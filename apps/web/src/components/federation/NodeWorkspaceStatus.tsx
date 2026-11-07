import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/** A node's display name among the command node's machines, for messages about it. */
export function nodeName(
  nodes: readonly { nodeId: string; view: { displayName: string } }[],
  id: string,
) {
  return nodes.find((node) => node.nodeId === id)?.view.displayName || "the machine";
}

/** Another node's workspace while it opens, or why it could not, with Try again. */
export function NodeWorkspaceStatus({
  failure,
  machine,
  onRetry,
}: {
  failure: string | null;
  machine: string;
  onRetry: () => void;
}) {
  if (!failure) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Opening {machine}…
      </div>
    );
  }
  return (
    <div
      role="alert"
      className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm"
    >
      <p className="flex items-center gap-2 text-destructive">
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        {failure}
      </p>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
