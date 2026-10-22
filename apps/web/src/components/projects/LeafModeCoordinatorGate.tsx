import { useEffect, useState, type ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import { repositoryHint } from "@/lib/federation/summaries";
import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { portalStore } from "@/lib/portal/portal-store";
import { workspaceTarget } from "@/lib/portal/portal-transport";
import { useProjectStore } from "@/stores";

/**
 * Coordinators belong to the command node. A node the user reaches through
 * a command node (this window's workspace is on a leaf), or a node attached
 * to another command node (leaf mode), keeps its own coordinator
 * conversations, since they may hold important information, but they stay
 * behind this notice, which leads to the command node's coordinator for the
 * same repository, until the user chooses to open them for this session.
 */
export function LeafModeCoordinatorGate({
  projectId,
  children,
}: {
  projectId?: string;
  children: ReactNode;
}) {
  const status = useStore(portalStore.store, (state) => state.status);
  const self = useStore(portalStore.store, (state) => state.self);
  const selfId = useStore(portalStore.store, (state) => state.selfId);
  const gitUrl = useProjectStore(
    (state) => state.projects.find((project) => project.id === projectId)?.gitUrl,
  );
  const [opened, setOpened] = useState(false);
  const onLeaf = workspaceTarget() !== null;
  useEffect(() => {
    if (!portalStore.getState().loaded) void portalStore.refresh();
  }, []);

  // The portal status is the command node's: on a leaf window it is not this node's mode.
  const leafMode = !onLeaf && status?.mode === "leaf";
  if (opened || (!onLeaf && !leafMode)) return <>{children}</>;

  const controllers = onLeaf
    ? (self?.displayName ?? "the command node")
    : (status?.controllers.map((entry) => entry.displayName).join(", ") ?? "");
  const hint = repositoryHint(gitUrl);
  const commandProject =
    onLeaf && hint ? self?.projects.find((project) => project.repositoryHint === hint) : undefined;

  return (
    <div
      id="project-panel-coordinator"
      role="tabpanel"
      className="flex h-full items-center justify-center p-6"
      data-testid="leaf-mode-coordinator-gate"
    >
      <div className="max-w-md space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
        <p className="flex items-center gap-2 font-medium text-amber-100">
          <ShieldAlert className="h-4 w-4" />
          {onLeaf ? "Coordination happens on the command node" : "This node is in leaf mode"}
        </p>
        <p className="text-muted-foreground">
          It is controlled by {controllers}. Coordination for this project happens there, not here.
          This node&apos;s own coordinator conversations are kept, but its coordinator does not act
          across nodes while this node is controlled.
        </p>
        <div className="flex flex-wrap gap-2">
          {commandProject && selfId ? (
            <Button
              type="button"
              size="sm"
              onClick={() =>
                openMachineWorkspace({
                  connectionId: selfId,
                  projectId: commandProject.ref.projectId,
                  title: commandProject.name,
                })
              }
            >
              Open the coordinator on {controllers}
            </Button>
          ) : null}
          <Button type="button" variant="outline" size="sm" onClick={() => setOpened(true)}>
            Open this node&apos;s coordinator anyway
          </Button>
        </div>
      </div>
    </div>
  );
}
