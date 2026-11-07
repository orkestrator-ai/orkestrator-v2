import { FolderGit2, GitBranch, Home } from "lucide-react";
import { useEffect, useState } from "react";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { useSignal } from "@/lib/node-scope/providers";
import { constantSignal } from "@/lib/node-scope/signal";
import type { NodeSnapshot, SnapshotEnvironment } from "@/lib/node-scope/snapshot-store";
import { scopeSnapshotSync, type ScopeSnapshotSync } from "@/lib/node-scope/snapshot-sync";
import { readNodeSnapshot } from "@/lib/node-snapshots";
import { cn } from "@/lib/utils";
import { SnapshotStaleMarker } from "./SnapshotStaleMarker";

const STATUS_DOT: Record<SnapshotEnvironment["status"], string> = {
  running: "bg-emerald-500",
  creating: "bg-amber-500",
  stopping: "bg-amber-500",
  stopped: "bg-muted-foreground/40",
  error: "bg-destructive",
};

/**
 * A node's workspace as this window last saw it (plan item 4003, report
 * §8.3), painted from its local snapshot the moment the node is opened: its
 * projects and environments, with the last selection marked. It is read-only
 * (nothing here acts on the node) and carries the stale marker; the real
 * workspace replaces it once the node's first authoritative read has landed.
 */
export function NodeSnapshotPreview({
  snapshot,
  machine,
  phase,
  now,
}: {
  snapshot: NodeSnapshot;
  machine: string;
  phase: "connecting" | "refreshing";
  now?: Date;
}) {
  const { selection } = snapshot;
  const byProject = new Map<string, SnapshotEnvironment[]>();
  for (const environment of snapshot.environments) {
    const list = byProject.get(environment.projectId) ?? [];
    list.push(environment);
    byProject.set(environment.projectId, list);
  }
  const selectedEnvironment = selection.environmentId
    ? snapshot.environments.find((environment) => environment.id === selection.environmentId)
    : undefined;
  const selectedProjectId = selectedEnvironment?.projectId ?? selection.projectId;
  const tabs = selectedEnvironment
    ? (snapshot.paneLayouts.find((layout) => layout.environmentId === selectedEnvironment.id)
        ?.tabIds.length ?? 0)
    : 0;

  return (
    <div
      data-testid="node-snapshot-preview"
      aria-busy="true"
      className="flex h-full flex-col overflow-hidden bg-background"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-foreground">{machine}</h2>
          {selectedEnvironment ? (
            <p className="truncate text-xs text-muted-foreground">
              {selectedEnvironment.name}
              {tabs > 0 ? ` · ${tabs} ${tabs === 1 ? "tab" : "tabs"}` : ""}
            </p>
          ) : null}
        </div>
        <SnapshotStaleMarker savedAt={snapshot.savedAt} phase={phase} now={now} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {snapshot.projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">No projects on {machine} yet.</p>
        ) : (
          <ul className="mx-auto flex max-w-3xl flex-col gap-3" aria-label={`${machine} projects`}>
            {snapshot.projects.map((project) => {
              const environments = byProject.get(project.id) ?? [];
              return (
                <li
                  key={project.id}
                  className={cn(
                    "rounded-lg border border-border/70 bg-card/40 px-3 py-2.5",
                    project.id === selectedProjectId && "border-primary/40 bg-primary/5",
                  )}
                >
                  <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <FolderGit2
                      className="h-4 w-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="truncate">{project.name}</span>
                    <span className="ml-auto shrink-0 text-xs font-normal text-muted-foreground">
                      {environments.length}{" "}
                      {environments.length === 1 ? "environment" : "environments"}
                    </span>
                  </p>
                  {environments.length > 0 ? (
                    <ul className="mt-2 flex flex-col gap-0.5">
                      {environments.map((environment) => (
                        <li
                          key={environment.id}
                          data-selected={environment.id === selection.environmentId || undefined}
                          className={cn(
                            "flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground",
                            environment.id === selection.environmentId &&
                              "bg-accent text-accent-foreground",
                          )}
                        >
                          <span
                            className={cn(
                              "h-1.5 w-1.5 shrink-0 rounded-full",
                              STATUS_DOT[environment.status],
                            )}
                            aria-label={environment.status}
                          />
                          {environment.projectHome ? (
                            <Home className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          ) : null}
                          <span className="truncate text-foreground/90">{environment.name}</span>
                          <span className="ml-auto flex min-w-0 shrink items-center gap-1">
                            <GitBranch className="h-3 w-3 shrink-0" aria-hidden="true" />
                            <span className="truncate">{environment.branch}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * `nodeId`'s local snapshot, read once per open (`key`: a retry reads again);
 * `null` while it is read and when there is none.
 */
export function useNodeSnapshot(nodeId: string, key: unknown): NodeSnapshot | null {
  const [read, setRead] = useState<{ nodeId: string; key: unknown; snapshot: NodeSnapshot } | null>(
    null,
  );
  useEffect(() => {
    let current = true;
    void readNodeSnapshot(nodeId).then((snapshot) => {
      if (current && snapshot) setRead({ nodeId, key, snapshot });
    });
    return () => {
      current = false;
    };
  }, [nodeId, key]);
  return read?.nodeId === nodeId && read.key === key ? read.snapshot : null;
}

const LIVE_SYNC = constantSignal<ScopeSnapshotSync>({ state: "live" });

/** Whether `scope` still shows its snapshot (`resyncing`) or authoritative data (`live`). */
export function useScopeSnapshotSync(scope: NodeScope | null): ScopeSnapshotSync {
  return useSignal(scope ? scopeSnapshotSync(scope) : LIVE_SYNC);
}
