import type { ReactNode } from "react";
import { useNodeScope } from "@/lib/node-scope/providers";
import { hydratedScopeSnapshot } from "@/lib/node-snapshots";
import { NodeSnapshotPreview, useScopeSnapshotSync } from "./NodeSnapshotPreview";

/**
 * The nearest node scope's views, or, while that scope still shows the local
 * snapshot it was hydrated from (plan item 4003), the snapshot read-only with
 * the stale marker. `App` wraps the command node's own workspace in it: the
 * views mount on authoritative data only, as `InTreeWorkspace` does for a
 * node in the window's tree, because a stale environment would start
 * terminals and restores against what it was. A scope never hydrated from a
 * snapshot renders `children` unchanged.
 */
export function ScopeSnapshotGate({ machine, children }: { machine: string; children: ReactNode }) {
  const scope = useNodeScope();
  const sync = useScopeSnapshotSync(scope);
  const snapshot = sync.state === "resyncing" ? hydratedScopeSnapshot(scope) : null;
  if (snapshot)
    return <NodeSnapshotPreview snapshot={snapshot} machine={machine} phase="refreshing" />;
  return <>{children}</>;
}
